import { Debug } from "../../Debug";
import type { ReadonlyVideoFrameData } from "../../API";

const VERTEX_SHADER_SRC = `#version 300 es
out vec2 v_uv;
void main() {
    // Full-screen triangle covering clip space [-1, 1]
    vec2 pos = vec2(
        (gl_VertexID == 1) ? 3.0 : -1.0,
        (gl_VertexID == 2) ? 3.0 : -1.0
    );
    v_uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
    gl_Position = vec4(pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SRC = `#version 300 es
precision mediump float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_texY;
uniform sampler2D u_texU;
uniform sampler2D u_texV;
uniform int u_colorMatrix; // 0=BT.709, 1=BT.601, 2=BT.2020
uniform int u_colorRange;  // 0=Limited (TV), 1=Full (PC)

void main() {
    float yRaw = texture(u_texY, v_uv).r;
    float uRaw = texture(u_texU, v_uv).r;
    float vRaw = texture(u_texV, v_uv).r;

    float y, u, v;
    if (u_colorRange == 0) {
        y = (yRaw - 16.0 / 255.0) * (255.0 / 219.0);
        u = (uRaw - 128.0 / 255.0) * (255.0 / 224.0);
        v = (vRaw - 128.0 / 255.0) * (255.0 / 224.0);
    } else {
        y = yRaw;
        u = uRaw - 0.5;
        v = vRaw - 0.5;
    }

    vec3 rgb;
    if (u_colorMatrix == 1) {
        // BT.601
        rgb = vec3(
            y + 1.402 * v,
            y - 0.344136 * u - 0.714136 * v,
            y + 1.772 * u
        );
    } else if (u_colorMatrix == 2) {
        // BT.2020
        rgb = vec3(
            y + 1.4746 * v,
            y - 0.164553 * u - 0.571353 * v,
            y + 1.8814 * u
        );
    } else {
        // BT.709
        rgb = vec3(
            y + 1.5748 * v,
            y - 0.187324 * u - 0.468124 * v,
            y + 1.8556 * u
        );
    }

    outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        void Debug.warn('WebGLVideoRenderer: shader compile failed:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createPlaneTexture(gl: WebGL2RenderingContext, unit: number): WebGLTexture | null {
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
}

export class WebGLVideoRenderer {
    readonly canvas: OffscreenCanvas;
    #gl: WebGL2RenderingContext;
    #program: WebGLProgram;
    #vao: WebGLVertexArrayObject;
    #texY: WebGLTexture;
    #texU: WebGLTexture;
    #texV: WebGLTexture;
    #locColorMatrix: WebGLUniformLocation | null;
    #locColorRange: WebGLUniformLocation | null;
    #texWidth = 0;
    #texHeight = 0;

    private constructor(
        canvas: OffscreenCanvas,
        gl: WebGL2RenderingContext,
        program: WebGLProgram,
        vao: WebGLVertexArrayObject,
        texY: WebGLTexture,
        texU: WebGLTexture,
        texV: WebGLTexture,
    ) {
        this.canvas = canvas;
        this.#gl = gl;
        this.#program = program;
        this.#vao = vao;
        this.#texY = texY;
        this.#texU = texU;
        this.#texV = texV;

        gl.useProgram(program);
        gl.uniform1i(gl.getUniformLocation(program, 'u_texY'), 0);
        gl.uniform1i(gl.getUniformLocation(program, 'u_texU'), 1);
        gl.uniform1i(gl.getUniformLocation(program, 'u_texV'), 2);
        this.#locColorMatrix = gl.getUniformLocation(program, 'u_colorMatrix');
        this.#locColorRange = gl.getUniformLocation(program, 'u_colorRange');
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    }

    static create(): WebGLVideoRenderer | null {
        try {
            const canvas = new OffscreenCanvas(2, 2);
            const gl = canvas.getContext('webgl2', {
                alpha: false,
                antialias: false,
                depth: false,
                stencil: false,
                preserveDrawingBuffer: true,
                powerPreference: 'high-performance',
            });
            if (!gl) return null;

            const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
            const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
            if (!vs || !fs) {
                if (vs) gl.deleteShader(vs);
                if (fs) gl.deleteShader(fs);
                return null;
            }

            const program = gl.createProgram();
            if (!program) {
                gl.deleteShader(vs);
                gl.deleteShader(fs);
                return null;
            }
            gl.attachShader(program, vs);
            gl.attachShader(program, fs);
            gl.linkProgram(program);
            gl.deleteShader(vs);
            gl.deleteShader(fs);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                void Debug.warn('WebGLVideoRenderer: program link failed:', gl.getProgramInfoLog(program));
                gl.deleteProgram(program);
                return null;
            }

            const vao = gl.createVertexArray();
            const texY = createPlaneTexture(gl, 0);
            const texU = createPlaneTexture(gl, 1);
            const texV = createPlaneTexture(gl, 2);
            if (!vao || !texY || !texU || !texV) {
                if (vao) gl.deleteVertexArray(vao);
                if (texY) gl.deleteTexture(texY);
                if (texU) gl.deleteTexture(texU);
                if (texV) gl.deleteTexture(texV);
                gl.deleteProgram(program);
                return null;
            }

            return new WebGLVideoRenderer(canvas, gl, program, vao, texY, texU, texV);
        } catch (e) {
            void Debug.warn('WebGLVideoRenderer: initialization failed, falling back to Canvas2D:', e);
            return null;
        }
    }

    render(frame: ReadonlyVideoFrameData): boolean {
        const gl = this.#gl;
        if (gl.isContextLost()) return false;

        const w = frame.width;
        const h = frame.height;
        const cw = w >> 1;
        const ch = h >> 1;
        const ySize = w * h;
        const uvSize = cw * ch;
        const data = frame.content.data;
        if (data.byteLength < ySize + uvSize * 2) return false;

        const yPlane = data.subarray(0, ySize);
        const uPlane = data.subarray(ySize, ySize + uvSize);
        const vPlane = data.subarray(ySize + uvSize, ySize + uvSize * 2);

        const sizeChanged = w !== this.#texWidth || h !== this.#texHeight;
        if (sizeChanged) {
            this.canvas.width = w;
            this.canvas.height = h;
            this.#texWidth = w;
            this.#texHeight = h;
            gl.viewport(0, 0, w, h);
        }

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.#texY);
        if (sizeChanged) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, yPlane);
        } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, yPlane);
        }

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.#texU);
        if (sizeChanged) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cw, ch, 0, gl.RED, gl.UNSIGNED_BYTE, uPlane);
        } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cw, ch, gl.RED, gl.UNSIGNED_BYTE, uPlane);
        }

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.#texV);
        if (sizeChanged) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cw, ch, 0, gl.RED, gl.UNSIGNED_BYTE, vPlane);
        } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cw, ch, gl.RED, gl.UNSIGNED_BYTE, vPlane);
        }

        gl.useProgram(this.#program);
        gl.uniform1i(this.#locColorMatrix, frame.colorMatrix);
        gl.uniform1i(this.#locColorRange, frame.colorRange);
        gl.bindVertexArray(this.#vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return true;
    }

    dispose() {
        const gl = this.#gl;
        gl.deleteTexture(this.#texY);
        gl.deleteTexture(this.#texU);
        gl.deleteTexture(this.#texV);
        gl.deleteVertexArray(this.#vao);
        gl.deleteProgram(this.#program);
    }
}

/**
 * Software fallback converting tightly packed YUV420P into RGBA ImageData when WebGL2 is unavailable.
 */
export function convertYUV420PToRGBA(frame: ReadonlyVideoFrameData, dst: Uint8ClampedArray): void {
    const w = frame.width;
    const h = frame.height;
    const cw = w >> 1;
    const ySize = w * h;
    const uvSize = cw * (h >> 1);
    const data = frame.content.data;
    const uBase = ySize;
    const vBase = ySize + uvSize;

    const limited = frame.colorRange === 0;
    const [kr, kg1, kg2, kb] = frame.colorMatrix === 1
        ? [1.402, 0.344136, 0.714136, 1.772]
        : frame.colorMatrix === 2
            ? [1.4746, 0.164553, 0.571353, 1.8814]
            : [1.5748, 0.187324, 0.468124, 1.8556];

    for (let row = 0; row < h; row++) {
        const yRow = row * w;
        const uvRow = (row >> 1) * cw;
        let outIdx = yRow * 4;
        for (let col = 0; col < w; col++) {
            const uvIdx = uvRow + (col >> 1);
            const yVal = limited ? (data[yRow + col] - 16) * (255 / 219) : data[yRow + col];
            const uVal = limited ? (data[uBase + uvIdx] - 128) * (255 / 224) : data[uBase + uvIdx] - 128;
            const vVal = limited ? (data[vBase + uvIdx] - 128) * (255 / 224) : data[vBase + uvIdx] - 128;

            dst[outIdx] = yVal + kr * vVal;
            dst[outIdx + 1] = yVal - kg1 * uVal - kg2 * vVal;
            dst[outIdx + 2] = yVal + kb * uVal;
            dst[outIdx + 3] = 255;
            outIdx += 4;
        }
    }
}
