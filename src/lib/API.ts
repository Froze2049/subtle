import { invoke, Channel } from '@tauri-apps/api/core';
import { Debug } from './Debug';
import { BinaryReader } from './details/BinaryReader';
import type { MediaEvent } from './bindings/MediaEvent';
import type { StreamDescription } from './bindings/StreamDescription';
import type { ResolvedFontFamily } from './bindings/ResolvedFontFamily';
import type { SubsetResult } from './bindings/SubsetResult';
import type { BufferHandle, ReadonlyBufferHandle, SlabBuffer } from './details/SlabBuffer';
import type { DiffEntry } from './bindings/DiffEntry';
import type { EntryScorer } from './bindings/EntryScorer';
import type { MatchResult } from './bindings/MatchResult';

export class MediaError extends Error {
    constructor(msg: string, public readonly from: string) {
        super(`${msg} (${from})`);
        this.name = 'MediaError';
    }
}

type MediaEventKey = MediaEvent['event'];
type MediaEventData = {[E in MediaEvent as E['event']]: E['data']};
type MediaEventHandler<key extends MediaEventKey> = (data: MediaEventData[key]) => void;

export type VideoStatus = MediaEventData['videoStatus'];
export type AudioStatus = MediaEventData['audioStatus'];
export type SampleResult = MediaEventData['sampleDone'];
export type BackendSubtitleData = MediaEventData['subtitleData'];

function createChannel(
    from: string, handler: {[key in MediaEventKey]?: MediaEventHandler<key>},
    reject: (e: unknown) => void, timeout = 2000
) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeout > 0) timer = setTimeout(
        () => reject(new MediaError(`timed out [${timeout}ms]`, from)), timeout);

    const channel = new Channel<MediaEvent>;
    channel.onmessage = (msg) => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        const h = handler[msg.event];
        if (h) {
            h(msg.data as never);
            return;
        }

        switch (msg.event) {
        case 'debug':
            void Debug.info(msg.data.message);
            break;
        case 'runtimeError':
            return reject(new MediaError('runtimeError: ' + msg.data.what, from));
        case 'invalidId':
            return reject(new MediaError('invalid media ID referenced', from));
        default:
            return reject(new Error('unhandled event: ' + msg.event));
        }
    }
    // Debug.trace('created channel for', from);
    return channel;
}

function invokeWithChannel<T>(
    command: string,
    from: string,
    args: (channel: Channel<MediaEvent>) => Record<string, unknown>,
    handler: (
        resolve: (value: T) => void,
        reject: (e: unknown) => void
    ) => {[key in MediaEventKey]?: MediaEventHandler<key>},
    timeout = 2000
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finishResolve = (value: T) => {
            settled = true;
            resolve(value);
        };
        const finishReject = (err: unknown) => {
            settled = true;
            if (err instanceof Error) {
                reject(err);
            } else {
                const msg = typeof err === 'string'
                    ? err
                    : err == null ? 'command failed' : JSON.stringify(err);
                reject(new MediaError(msg, from));
            }
        };
        const channel = createChannel(from, handler(finishResolve, finishReject), finishReject, timeout);
        invoke(command, args(channel)).catch((err) => {
            if (!settled) {
                finishReject(err);
            }
        });
    });
}

export type VideoFrameData = {
    readonly pktpos: number,
    readonly time: number,
    readonly stride: number,
    readonly length: number,
    readonly size: readonly [width: number, height: number],
    readonly content: BufferHandle<ImageDataArray>
};

export type ReadonlyVideoFrameData = {
    readonly pktpos: number,
    readonly time: number,
    readonly stride: number,
    readonly length: number,
    readonly size: readonly [width: number, height: number],
    readonly content: ReadonlyBufferHandle<ImageDataArray>
};

export type AudioFrameData = {
    pktpos: number,
    time: number,
    length: number,
    content: Float32Array
};

export type DecodeResult = {
    video: VideoFrameData[],
    audio: AudioFrameData[],
    readTime: number
}

export class MMedia {
    #destroyed = false;
    #currentJobs = 0;
    #video: VideoStatus | undefined;
    #audio: AudioStatus | undefined;
    #outSize: [number, number] = [-1, -1];
    #eof = false;

    get video(): Readonly<VideoStatus> | undefined {
        return this.#video;
    }

    get audio(): Readonly<AudioStatus> | undefined {
        return this.#audio;
    }

    get outputSize(): readonly [number, number] {
        return this.#outSize;
    }

    get streams(): readonly StreamDescription[] {
        return this._streams;
    }

    get duration() {
        return this._duration;
    }

    get hasJob() {
        Debug.assert(this.#currentJobs >= 0);
        return this.#currentJobs != 0;
    }

    get isEOF() {
        return this.#eof;
    }

    private constructor(
        private id: number,
        private _duration: number,
        private _streams: StreamDescription[]
    ) {
        void Debug.info(`media ${id} opened`);
    }

    #readFrames(
        data: ArrayBuffer,
        pool: SlabBuffer<ImageDataArray>
    ): DecodeResult {
        const start = performance.now();

        const view = new BinaryReader(data);
        const nA = view.readU32();
        const audio: AudioFrameData[] = [];
        for (let i = 0; i < nA; i++)
            audio.push(this.#readAudioFrame(view));

        const nV = view.readU32();
        // Debug.trace(`readFrames: ${nV} video frames in the pack`);
        const video: VideoFrameData[] = [];
        for (let i = 0; i < nV; i++)
            video.push(this.#readVideoFrame(view, pool));

        return { audio, video, readTime: performance.now() - start };
    }

    #readAudioFrame(view: BinaryReader<ArrayBuffer>): AudioFrameData {
        const time = view.readF64();
        const pktpos = view.readI64();
        const length = view.readU32();
        const content = view.readF32Array(length, { copy: true });
        return { pktpos, time, length, content };
    }

    #readVideoFrame(
        view: BinaryReader<ArrayBuffer>,
        pool: SlabBuffer<ImageDataArray>
    ): VideoFrameData {
        const time = view.readF64();
        const pktpos = view.readI64();
        const stride = view.readU32();
        const length = view.readU32();
        const content = view.readU8ClampedArray(length, { copy: false });
        const buf = pool.allocate(length);
        buf.data.set(content);
        return { pktpos, time, stride, length, content: buf, size: [...this.#outSize] };
    }

    static async open(path: string) {
        const id = await invokeWithChannel<number>('open_media', 'open',
            (channel) => ({ path, channel }),
            (resolve) => ({ opened: (data) => resolve(data.id) }));
        const status = await invokeWithChannel<{
            audioIndex: number,
            videoIndex: number,
            duration: number,
            streams: StreamDescription[]
        }>('media_status', 'open/status',
            (channel) => ({ id, channel }),
            (resolve) => ({ mediaStatus: (data) => resolve(data) }));
        return new MMedia(id, status.duration, status.streams);
    }

    get isClosed() {
        return this.#destroyed;
    }

    async close() {
        Debug.assert(!this.#destroyed);
        await invokeWithChannel<void>('close_media', 'close',
            (channel) => ({ id: this.id, channel }),
            (resolve) => ({
                done: () => {
                    void Debug.info(`media ${this.id} closed`);
                    this.#destroyed = true;
                    // IPC.deleteListeners(this);
                    resolve();
                }
            }));
    }

    async openAudio(audioId: number) {
        Debug.assert(!this.#destroyed);
        this.#audio = await invokeWithChannel<AudioStatus>('open_audio', 'openAudio',
            (channel) => ({ id: this.id, audioId, channel }),
            (resolve) => ({ audioStatus: (data) => resolve(data) }));
        return this.#audio;
    }

    async openAudioSampler(audioId: number, samplePerSecond: number) {
        Debug.assert(!this.#destroyed);
        this.#audio = await invokeWithChannel<AudioStatus>('open_audio_sampler', 'openAudioSampler',
            (channel) => ({ id: this.id, audioId, samplePerSecond, channel }),
            (resolve) => ({ audioStatus: (data) => resolve(data) }));
        return this.#audio;
    }

    async openVideo(videoId: number, accel: boolean) {
        Debug.assert(!this.#destroyed);
        this.#video = await invokeWithChannel<VideoStatus>('open_video', 'openVideo',
            (channel) => ({ id: this.id, videoId, accel, channel }),
            (resolve) => ({ videoStatus: (data) => resolve(data) }));
        this.#outSize = [...this.#video.size];
        return this.#video;
    }

    async openVideoSampler(videoId: number, accel: boolean) {
        Debug.assert(!this.#destroyed);
        this.#video = await invokeWithChannel<VideoStatus>('open_video_sampler', 'openVideoSampler',
            (channel) => ({ id: this.id, videoId, accel, channel }),
            (resolve) => ({ videoStatus: (data) => resolve(data) }));
        return this.#video;
    }

    async extractSubtitles(subId: number) {
        Debug.assert(!this.#destroyed);
        return await invokeWithChannel<BackendSubtitleData>('extract_subtitles', 'extractSubtitles',
            (channel) => ({ id: this.id, subId, channel }),
            (resolve) => ({
                subtitleData: (data) => resolve(data),
                progress: (data) => void Debug.info('progress: ', data.value),
            }), -1);
    }

    async setVideoSize(width: number, height: number) {
        Debug.assert(!this.#destroyed);
        Debug.assert(this.#video !== undefined);
        width = Math.max(1, Math.round(width));
        height = Math.max(1, Math.round(height));
        await invokeWithChannel<void>('video_set_size', 'setVideoSize',
            (channel) => ({ id: this.id, channel, width, height }),
            (resolve) => ({ done: () => resolve() }));
        this.#outSize = [width, height];
    }

    async sampleAutomatic(targetWorkingTimeMs: number): Promise<SampleResult> {
        Debug.assert(!this.#destroyed);
        Debug.assert(this.#currentJobs == 0);
        this.#currentJobs += 1;
        try {
            return await invokeWithChannel<SampleResult>('sample_automatic', 'sampleAutomatic',
                (channel) => ({ id: this.id, targetWorkingTimeMs, channel }),
                (resolve) => ({ sampleDone: (data) => resolve(data) }));
        } finally {
            this.#currentJobs -= 1;
        }
    }

    async decodeAutomatic(
        targetWorkingTimeMs: number,
        pool: SlabBuffer<ImageDataArray>
    ) {
        Debug.assert(!this.#destroyed);
        Debug.assert(this.#currentJobs == 0);
        this.#currentJobs += 1;
        try {
            const channel = new Channel<MediaEvent>();
            channel.onmessage = (msg) => {
                if (msg.event === 'debug')
                    void Debug.info(msg.data.message);
            };
            const result = await invoke<ArrayBuffer>('get_frames_automatic', {
                id: this.id, targetWorkingTimeMs, channel
            });
            return this.#readFrames(result, pool);
        } finally {
            this.#currentJobs -= 1;
        }
    }

    async seek(time: number) {
        Debug.assert(!this.#destroyed);
        Debug.assert(this.#currentJobs == 0);
        this.#currentJobs += 1;
        try {
            return await invokeWithChannel<void>('seek_media', 'seek',
                (channel) => ({ id: this.id, channel, time }),
                (resolve) => ({ done: () => resolve() }));
        } finally {
            this.#currentJobs -= 1;
        }
    }

    async seekByte(pos: number) {
        Debug.assert(!this.#destroyed);
        Debug.assert(this.#currentJobs == 0);
        this.#currentJobs += 1;
        try {
            return await invokeWithChannel<void>('seek_media_byte', 'seekByte',
                (channel) => ({ id: this.id, channel, pos }),
                (resolve) => ({ done: () => resolve() }));
        } finally {
            this.#currentJobs -= 1;
        }
    }

    async seekAudio(time: number) {
        Debug.assert(!this.#destroyed);
        Debug.assert(this.#currentJobs == 0);
        this.#currentJobs += 1;
        try {
            return await invokeWithChannel<void>('seek_audio', 'seekAudio',
                (channel) => ({ id: this.id, channel, time }),
                (resolve) => ({ done: () => resolve() }));
        } finally {
            this.#currentJobs -= 1;
        }
    }

    async seekVideo(time: number) {
        Debug.assert(!this.#destroyed);
        Debug.assert(this.#currentJobs == 0);
        this.#currentJobs += 1;
        try {
            return await invokeWithChannel<void>('seek_video', 'seekVideo',
                (channel) => ({ id: this.id, channel, time }),
                (resolve) => ({ done: () => resolve() }));
        } finally {
            this.#currentJobs -= 1;
        }
    }

    async skipUntil(time: number, pool: SlabBuffer<ImageDataArray>) {
        Debug.assert(!this.#destroyed);
        Debug.assert(this.#currentJobs == 0);
        this.#currentJobs += 1;
        try {
            const channel = new Channel<MediaEvent>();
            channel.onmessage = (msg) => {
                if (msg.event === 'debug')
                    void Debug.info(msg.data.message);
            };
            const result = await invoke<ArrayBuffer>('skip_until', {
                id: this.id, time, channel
            });
            if (result.byteLength > 0)
                return this.#readFrames(result, pool);
            return { audio: [], video: [], readTime: 0 };
        } finally {
            this.#currentJobs -= 1;
        }
    }

    async getKeyframeBefore(time: number) {
        Debug.assert(!this.#destroyed);
        return await invokeWithChannel<MediaEventData['frameQueryResult'] | null>('get_keyframe_before', 'getKeyframeBefore',
            (channel) => ({ id: this.id, channel, time }),
            (resolve) => ({
                frameQueryResult: (data) => resolve(data),
                noResult: () => resolve(null)
            }));
    }

    async getFrameBefore(time: number) {
        Debug.assert(!this.#destroyed);
        return await invokeWithChannel<MediaEventData['frameQueryResult'] | null>('get_frame_before', 'getFrameBefore',
            (channel) => ({ id: this.id, channel, time }),
            (resolve) => ({
                frameQueryResult: (data) => resolve(data),
                noResult: () => resolve(null)
            }));
    }
}

export const MAPI = {
    async version() {
        return await invokeWithChannel<string>('media_version', 'version',
            (channel) => ({ channel }),
            (resolve) => ({ ffmpegVersion: (data) => resolve(data.value) }));
    },

    async config() {
        return await invoke<string>('media_config', {});
    },

    async testPerformance(path: string, postprocess: boolean, hwaccel: boolean) {
        return await invokeWithChannel<void>('test_performance', 'test_performance',
            (channel) => ({ path, postprocess, hwaccel, channel }),
            (resolve) => ({ done: () => resolve() }), -1);
    },

    async decodeFile(path: string, encoding: string | null) {
        const { type, data } = await invoke<{ type: 'ok' | 'error', data: string }>(
            'decode_file_as', { path, encoding });
        if (type == 'error') throw new Error(`decode_file_as: ${data}`);
        return data;
    },

    async detectOrDecodeFile(path: string) {
        const result = await invoke<{
            type: 'normal' | 'error', data: string
        } | { type: 'strange' }>(
            'decode_or_detect_file', { path });
        if (result.type == 'error') throw new Error(`decode_or_detect_file: ${result.data}`);
        if (result.type == 'strange') return null;
        return result.data;
    },

    async readSubz(path: string) {
        return await invoke<string>('read_subz', { path });
    },

    async writeSubz(path: string, data: string) {
        await invoke<void>('write_subz', { path, data });
    },

    async takePendingFiles() {
        return await invoke<string[]>('take_pending_files');
    },

    async openDevtools() {
        await invoke<void>('open_devtools');
    },

    async pushHistory(data: string) {
        await invoke<void>('push_history', { data });
    },

    async clearHistory(data: string) {
        await invoke<void>('clear_history', { data });
    },

    async readUndo() {
        return await invoke<string>('read_undo');
    },

    async readRedo() {
        return await invoke<string>('read_redo');
    },

    async resolveFontFamily(name: string) {
        return await invoke<ResolvedFontFamily | null>('resolve_family', { name });
    },

    async getAllFontFamilies() {
        return await invoke<string[]>('get_all_font_families', {});
    },

    async subsetEncode(path: string, index: number, text: string) {
        return await invoke<SubsetResult>('subset_encode', { path, index, text });
    },

    async matchEntries(
        a: DiffEntry[], b: DiffEntry[],
        scorer: EntryScorer, report: (p: number, total: number) => void
    ) {
        const channel = new Channel<[number, number]>(([p, t]) => report(p, t));
        return await invoke<MatchResult | null>('diff_entries', { a, b, scorer, channel });
    }
};
