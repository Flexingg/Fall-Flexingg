/**
 * The in-app preview of the Android "health galaxy" live wallpaper: the same fragment shader and
 * intro timings as GalaxyRenderer / ValueAnimator on the native side, drawn with WebGL.
 */
import FRAG from '../../shaders/wallpaper/galaxy.frag?raw';

export const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';

/** Channel order: calories, protein, carbs, fat, water, volume, fade. Seconds. */
const DELAYS = [0.2, 0.5, 0.8, 1.1, 1.4, 1.2, 0];
const DURATIONS = [3.0, 2.8, 2.8, 2.8, 2.8, 2.8, 1.5];
const RETARGET_SECONDS = 1.5;
const FADE = 6;

const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;

/** Eases each value toward its target: the intro on show, then a short glide when data changes. */
export class GalaxyAnimator {
  private from = new Float32Array(7);
  private to = new Float32Array(7);
  private start = new Float32Array(7);
  private dur = new Float32Array(7);

  /** targets: calories, protein, carbs, fat, water, volume fractions. */
  intro(targets: readonly number[], now: number) {
    for (let i = 0; i < 7; i++) {
      this.from[i] = 0;
      this.to[i] = i === FADE ? 1 : (targets[i] ?? 0);
      this.start[i] = now + DELAYS[i]!;
      this.dur[i] = DURATIONS[i]!;
    }
  }

  retarget(targets: readonly number[], now: number) {
    for (let i = 0; i < FADE; i++) {
      const t = targets[i] ?? 0;
      if (t === this.to[i]) continue;
      this.from[i] = this.value(i, now);
      this.to[i] = t;
      this.start[i] = now;
      this.dur[i] = RETARGET_SECONDS;
    }
  }

  value(i: number, now: number): number {
    const x = Math.min(Math.max((now - this.start[i]!) / this.dur[i]!, 0), 1);
    return this.from[i]! + (this.to[i]! - this.from[i]!) * easeOutCubic(x);
  }
}

export class GalaxyGL {
  private readonly gl: WebGLRenderingContext;
  private uA: WebGLUniformLocation | null = null;
  private uB: WebGLUniformLocation | null = null;
  private uRes: WebGLUniformLocation | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    this.init();
  }

  /** (Re)builds the program, e.g. after the context was lost and restored. */
  init() {
    const gl = this.gl;
    const highp =
      (gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision ?? 0) > 0;
    // Without highp the noise bands; fewer octaves keep it smooth.
    const frag = highp ? FRAG : FRAG.replace('i<5;', 'i<3;');
    const prog = gl.createProgram()!;
    for (const [type, src] of [
      [gl.VERTEX_SHADER, VERT],
      [gl.FRAGMENT_SHADER, frag],
    ] as const) {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost())
        throw new Error(gl.getShaderInfoLog(sh) ?? 'Shader failed to compile');
      gl.attachShader(prog, sh);
    }
    gl.bindAttribLocation(prog, 0, 'p');
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.uA = gl.getUniformLocation(prog, 'uA');
    this.uB = gl.getUniformLocation(prog, 'uB');
    this.uRes = gl.getUniformLocation(prog, 'uRes');
  }

  draw(anim: GalaxyAnimator, now: number, seconds: number) {
    const { gl, canvas } = this;
    if (gl.isContextLost()) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    const v = (i: number) => anim.value(i, now);
    gl.uniform4f(this.uA, v(0), v(1), v(2), v(3));
    gl.uniform4f(this.uB, v(4), v(5), v(FADE), seconds);
    gl.uniform2f(this.uRes, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
