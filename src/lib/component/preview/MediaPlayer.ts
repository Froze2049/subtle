import { MMedia, type AudioStatus, type ReadonlyVideoFrameData } from "../../API";
import { Basic } from "../../Basic";
import type { CanvasManager } from "../../CanvasManager";
import { InterfaceConfig } from "../../config/Groups";
import { Debug } from "../../Debug";
import { Mutex } from "../../details/Mutex";
import { Playback } from "../../frontend/Playback";
import { Audio } from "./Audio";
import { MediaConfig } from "./Config";
import { AsyncEventHost, EventHost } from "@the_dissidents/svelte-ui";
import { PlayerBuffer, type SeekOptions } from "./PlayerBuffer";
import { WebGLVideoRenderer, convertYUV420PToRGBA } from "./WebGLVideoRenderer";
import { barPlot } from "$lib/details/DebugPlot";

const DAMPING = 0.5;
const N_LATENCY = 100;

export const MediaPlayerInterface = {
    onPlayback: new EventHost<[pos: number]>(),
    onPlayStateChanged: new EventHost<[]>(),
    getLatencies: () => [] as number[],
};

export class MediaPlayer {
    readonly #buffer: PlayerBuffer;

    #intent: 'playing' | 'paused' | 'closed' = 'paused';
    #mutex = new Mutex(1000, 'MediaPlayer');

    #webgl: WebGLVideoRenderer | null;
    #fallbackCanvas?: OffscreenCanvas;
    #fallbackCtx?: OffscreenCanvasRenderingContext2D;
    #fallbackImageData?: ImageData;
    #bufFrameSize: [number, number] = [0, 0];
    #lastFrameTime = 0;
    #hasFrame = false;
    #displayOffset: [number, number] = [0, 0];
    #displaySize: [number, number] = [1, 1];
    #lastRequestedDecodeSize: [number, number] = [0, 0];
    #resizeTimer?: ReturnType<typeof setTimeout>;
    #clockRafId: number | null = null;
    #lastClockPos = -1;

    #diag = {
        latencies: [] as number[],
        latencySquared: 0,
        delay: 0,
        waitForAudio: 0,
    }

    get source() { return this.rawurl; }
    get isPlaying() { return this.#intent == 'playing'; }

    get duration() { return this.#buffer.media.duration; }
    get streams() { return this.#buffer.media.streams; }
    get currentAudioStream() { return this.#buffer.media.audio!.index; }
    get frameRate() { return this.#buffer.media.video!.framerate; }
    get isVfr() { return this.#buffer.media.video!.isVfr; }
    get videoSize() { return this.#buffer.media.video?.size; }
    get sampleAspectRatio() { return this.#buffer.media.video?.sampleAspectRatio; }

    get startTime() {
        return this.#buffer.startTime;
    }

    get endTime() {
        return this.#buffer.media.video!.startTime + this.#buffer.media.duration;
    }

    private constructor(
        media: MMedia, audio: Audio,
        private readonly manager: CanvasManager,
        private rawurl: string,
    ) {
        this.#webgl = WebGLVideoRenderer.create();
        if (!this.#webgl) {
            this.#fallbackCanvas = new OffscreenCanvas(2, 2);
            const ctx = this.#fallbackCanvas.getContext('2d', { alpha: false });
            if (!ctx) throw new Error("VideoPlayer: cannot create offscreen context");
            this.#fallbackCtx = ctx;
        }

        manager.onDisplaySizeChanged.bind(this, () => {
            this.#scheduleOutputSizeUpdate();
        });

        this.#buffer = new PlayerBuffer(media, audio);
        this.#buffer.onArrive.bind(this, (t) => {
            void Debug.trace('arrive', t);
            if (!this.#presenting) void this.#startPresenting();
            MediaPlayerInterface.onPlayback.dispatch(t);
        });
        void this.#updateOutputSize(true).catch((e) => Debug.forwardError(e));
        void this.#startPresenting().catch((e) => Debug.forwardError(e));

        MediaPlayerInterface.getLatencies = () => this.#diag.latencies;
    }

    #recalculateDisplayRect(): [number, number] {
        Debug.assert(this.#buffer.media.video !== undefined);

        const video = this.#buffer.media.video;
        const [w, h] = this.manager.physicalSize;
        const width = video.size[0] * video.sampleAspectRatio;
        const height = video.size[1];

        Debug.assert(height !== 0);
        const ratio = width / height;

        let [ow, oh] = w / h < ratio ? [w, w / ratio] : [h * ratio, h];
        this.#displayOffset = [Math.round((w - ow) / 2), Math.round((h - oh) / 2)];

        ow = Math.max(2, Math.round(ow) & ~1);
        oh = Math.max(2, Math.round(oh) & ~1);
        this.#displaySize = [ow, oh];

        if (MediaConfig.data.limitFrameSize > 0.5
         && ow * oh * 1.5 > MediaConfig.data.limitFrameSize * 1024 * 1024)
        {
            oh = Math.sqrt(MediaConfig.data.limitFrameSize / 1.5 / ratio) * 1024;
            ow = oh * ratio;
            ow = Math.max(2, Math.round(ow) & ~1);
            oh = Math.max(2, Math.round(oh) & ~1);
        }

        return [ow, oh];
    }

    #scheduleOutputSizeUpdate() {
        if (this.#intent === 'closed') return;
        this.#recalculateDisplayRect();
        if (this.#resizeTimer !== undefined) clearTimeout(this.#resizeTimer);
        this.#resizeTimer = setTimeout(() => {
            this.#resizeTimer = undefined;
            if (this.#intent !== 'closed')
                void this.#updateOutputSize(false).catch((e) => Debug.forwardError(e));
        }, 200);
    }

    async #updateOutputSize(immediate: boolean) {
        if (this.#intent === 'closed') return;
        const [ow, oh] = this.#recalculateDisplayRect();
        if (!immediate
         && ow === this.#lastRequestedDecodeSize[0]
         && oh === this.#lastRequestedDecodeSize[1])
            return;

        this.#lastRequestedDecodeSize = [ow, oh];
        if (this.isPlaying) {
            await this.stop();
        }
        return this.#buffer.resize(ow, oh);
    }

    static async create(manager: CanvasManager, rawurl: string, audioId: number) {
        const media = await MMedia.open(rawurl);
        let audioStatus: AudioStatus;
        try {
            await media.openVideo(-1, InterfaceConfig.data.useHwaccel);
            audioStatus = await media.openAudio(audioId);
            await Debug.debug('VideoPlayer: opened media');
        } catch (e) {
            if (!media.isClosed) await media.close();
            await Debug.error(e);
            throw e;
        }
        const audio = await Audio.create(audioStatus.sampleRate);
        const player = new MediaPlayer(media, audio, manager, rawurl);
        return player;
    }

    async close() {
        this.#stopClockLoop();
        if (this.#resizeTimer !== undefined) {
            clearTimeout(this.#resizeTimer);
            this.#resizeTimer = undefined;
        }
        EventHost.unbind(this);
        AsyncEventHost.unbind(this);

        await this.#mutex.use(async () => {
            if (this.#intent == 'closed') return Debug.early();
            this.#intent = 'closed';
            await Debug.info('closing media player');
            this.#webgl?.dispose();
            this.#webgl = null;
            await this.#buffer.close();
        });
    }

    get volume() {
        return this.#buffer.audio.volume;
    }

    async setVolume(value: number) {
        await this.#buffer.audio.setVolume(value);
    }

    get playbackRate() {
        return this.#buffer.audio.playbackRate;
    }

    async setPlaybackRate(value: number) {
        await this.#buffer.audio.setPlaybackRate(value);
    }

    #drawFrame(frame: ReadonlyVideoFrameData) {
        const ow = frame.width;
        const oh = frame.height;
        let rendered = false;
        if (this.#webgl) {
            rendered = this.#webgl.render(frame);
        }
        if (!rendered) {
            if (!this.#fallbackCanvas || !this.#fallbackCtx) {
                this.#fallbackCanvas = new OffscreenCanvas(ow, oh);
                const ctx = this.#fallbackCanvas.getContext('2d', { alpha: false });
                if (!ctx) return;
                this.#fallbackCtx = ctx;
            }
            if (this.#fallbackCanvas.width !== ow || this.#fallbackCanvas.height !== oh) {
                this.#fallbackCanvas.width = ow;
                this.#fallbackCanvas.height = oh;
            }
            if (!this.#fallbackImageData
             || this.#fallbackImageData.width !== ow
             || this.#fallbackImageData.height !== oh)
            {
                this.#fallbackImageData = new ImageData(ow, oh);
            }
            convertYUV420PToRGBA(frame, this.#fallbackImageData.data);
            this.#fallbackCtx.putImageData(this.#fallbackImageData, 0, 0);
        }
        this.#bufFrameSize = [ow, oh];
        this.#lastFrameTime = frame.time;
        this.#hasFrame = true;

        if (!MediaConfig.data.showDebug) return;
        const clock = this.#buffer.audio.time;
        if (clock !== undefined) {
            const latency = Math.round((clock - frame.time) * 1000);
            this.#diag.latencies.push(latency);
            if (this.#diag.latencies.length > N_LATENCY)
                this.#diag.latencies.shift();

            this.#diag.latencySquared = this.#diag.latencySquared * DAMPING
                + (latency * latency * (1 - DAMPING));
        }
    }

    async #presentNextLocked() {
        if (this.#intent === 'closed' || this.#buffer.state === 'error') return -1;

        // if not playing, just display the current frame
        if (!this.isPlaying) {
            const frame = this.#buffer.peekVideoFrame();
            if (!frame) return 0;

            MediaPlayerInterface.onPlayback.dispatch(frame.time);
            this.#drawFrame(frame);
            this.manager.requestRender();
            return -1;
        }

        // if there's no audio, we can't synchronize and must wait for it
        const clock = this.#buffer.audio.time;
        if (clock === undefined) return 0;

        // consume a frame
        return await this.#buffer.consumeVideoFrame(async (data) => {
            switch (data.type) {
                case "buffering":
                    await Debug.warn('presentNextLocked: buffer is empty');
                    return 0;
                case "eof":
                    await Debug.debug('presentNextLocked: at EOF');
                    void this.stop();
                    return -1;
                case "waiting_for_clock": {
                    this.#diag.waitForAudio += 1;
                    return (data.earliest - clock) / this.playbackRate;
                }
                case "ok": {
                    const frame = data.frame;
                    if (!this.isPlaying || this.#buffer.audio.interpolatedTime === undefined) {
                        MediaPlayerInterface.onPlayback.dispatch(frame.time);
                    }
                    this.#drawFrame(frame);
                    this.manager.requestRender();

                    const targetTime = (this.#buffer.peekVideoFrame() ?? frame).time;
                    const framerate = this.#buffer.media.video!.framerate;
                    const newClock = this.#buffer.audio.time;
                    if (newClock === undefined) {
                        // ???
                        return 0;
                    }
                    const rate = this.playbackRate;
                    let delay = Math.max(0, (targetTime - newClock) / rate);
                    const maxDelay = (2 / framerate) / rate;
                    if (delay > maxDelay) {
                        await Debug.warn(`presentNext: delay too long:`, delay);
                        delay = maxDelay;
                    }
                    return delay;
                }
            }
        }, { clock: clock });
    }

    #presenting = false;
    async #startPresenting() {
        Debug.assert(!this.#presenting);
        this.#presenting = true;
        try {
            while (true) {
                const delay = await this.#mutex.use(() => this.#presentNextLocked());
                this.#diag.delay = delay * 1000;
                if (delay < 0) break;
                // Align frame presentation with display vsync to eliminate setTimeout jitter.
                if (delay > 0.032) {
                    await Basic.wait((delay - 0.016) * 1000);
                }
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            }
        } finally {
            this.#presenting = false;
        }
    }

    renderTo(ctx: CanvasRenderingContext2D) {
        if (!this.#hasFrame || this.#bufFrameSize[0] <= 0 || this.#bufFrameSize[1] <= 0)
            return;
        const source = this.#webgl ? this.#webgl.canvas : this.#fallbackCanvas;
        if (!source) return;
        const [dx, dy] = this.#displayOffset;
        const [dw, dh] = this.#displaySize;
        ctx.drawImage(
            source,
            0, 0, this.#bufFrameSize[0], this.#bufFrameSize[1],
            dx, dy, dw, dh
        );

        if (!MediaConfig.data.showDebug) return;
        const [ow, oh] = this.#bufFrameSize;
        const rescaled = ow !== dw || oh !== dh;
        const videoSize = this.#buffer.videoBufferSize;
        const audioSize = this.#buffer.audio.bufferSize;
        const clock = this.#buffer.audio.time;
        const clockString = clock !== undefined ? clock.toFixed(3) : 'n/a!';
        const latencyStr = clock !== undefined
            ? Math.round((clock - this.#lastFrameTime) * 1000).toFixed(1)
            : 'n/a!';

        ctx.fillStyle = 'cyan';
        ctx.font = `${window.devicePixelRatio * 10}px Courier`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';

        ctx.fillText(`FPS ${this.frameRate.toFixed(3)}`
                   + `SPR ${this.#buffer.media.audio!.sampleRate}`, dx, dy);
        ctx.fillText(`ATi ${clockString} s`, dx, dy + 20);
        ctx.fillText(`VTi ${this.#lastFrameTime.toFixed(3)} s`, dx, dy + 40);
        ctx.fillText(`LAT${latencyStr.padStart(5)}`.padEnd(10)
                   + `STS ${Math.sqrt(this.#diag.latencySquared).toFixed(1).padStart(4)}`, dx, dy + 60);
        ctx.fillText(`DEL ${this.#diag.delay.toFixed(1).padStart(4)}`, dx, dy + 80);
        ctx.fillText(`VBL ${this.#buffer.videoBufferLength}`.padEnd(9)
                   + `(${(videoSize / 1024 / 1024).toFixed(2)}MB)`, dx, dy + 100);
        ctx.fillText(`ABL ${this.#buffer.audio.bufferLength}`.padEnd(9)
                   + `(${(audioSize / 1024).toFixed(0)}KB)`, dx, dy + 120);
        ctx.fillText((rescaled
            ? `RES ${ow}x${oh} -> ${dw}x${dh}`
            : `RES ${ow}x${oh}`) + (this.#webgl ? ' [GL2 YUV]' : ' [2D YUV]'), dx, dy + 140);
        ctx.fillText(`AFL ${this.#buffer.audio.lastFrameLength}`, dx, dy + 160);

        barPlot(ctx, this.#buffer.fetchTimes.map((v, i) => [i, v]), dx + dw - 200, dy + dh - 120, 200, 100);
        barPlot(ctx, this.#diag.latencies.map((v, i) => [i, [v]]), dx + dw - 200, dy, 200, 100);
    }

    #startClockLoop() {
        if (this.#clockRafId !== null) return;
        this.#lastClockPos = -1;
        const tickClock = () => {
            if (!this.isPlaying) {
                this.#clockRafId = null;
                return;
            }
            const t = this.#buffer.audio.interpolatedTime;
            if (t !== undefined) {
                const clamped = Math.max(this.startTime, Math.min(this.endTime, t));
                const nextPos = this.#lastClockPos >= 0 ? Math.max(this.#lastClockPos, clamped) : clamped;
                if (nextPos !== this.#lastClockPos) {
                    this.#lastClockPos = nextPos;
                    MediaPlayerInterface.onPlayback.dispatch(nextPos);
                }
            }
            this.#clockRafId = requestAnimationFrame(tickClock);
        };
        this.#clockRafId = requestAnimationFrame(tickClock);
    }

    #stopClockLoop() {
        if (this.#clockRafId !== null) {
            cancelAnimationFrame(this.#clockRafId);
            this.#clockRafId = null;
        }
        this.#lastClockPos = -1;
    }

    async play() {
        await this.#mutex.use(async () => {
            if (this.isPlaying || this.#intent == 'closed') return;
            this.#intent = 'playing';
            await Debug.trace('starting playback');
            await this.#buffer.audio.play();
            if (!this.#presenting) void this.#startPresenting();
        });
        this.#startClockLoop();
        MediaPlayerInterface.onPlayStateChanged.dispatch();
    }

    async stop() {
        this.#stopClockLoop();
        await this.#mutex.use(async () => {
            if (!this.isPlaying || this.#intent == 'closed') return;
            this.#intent = 'paused';
            await Debug.trace('stopping playback');
            await this.#buffer.audio.stop();
        });
        MediaPlayerInterface.onPlayStateChanged.dispatch();
    }

    async requestNextFrame() {
        Debug.assert(this.#intent !== 'closed');
        if (this.#buffer.state === 'eof') return;
        const pos = await this.#buffer.waitForPlayPosition();
        void this.seek(pos + 0.001);
    }

    async requestPreviousFrame() {
        Debug.assert(this.#intent !== 'closed');
        const pos = await this.#buffer.waitForPlayPosition();
        const result = await Playback.sampler?.getFrameBefore(pos);
        if (!result) {
            void Debug.warn('cannot find previous frame');
            return;
        }
        void this.seek(result.time);
    }

    async seek(t: number, opt?: SeekOptions) {
        if (t < this.startTime) t = this.startTime;
        if (t > this.endTime) t = this.endTime;
        await this.stop();
        return this.#buffer.seek(t, opt);
    }

    async setAudioStream(id: number) {
        return this.#buffer.setAudioStream(id);
    }
}
