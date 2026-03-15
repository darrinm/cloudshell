// ── CRT Post-Processing Effect ───────────────────────────────────────
//
// Self-contained CRT post-processing pass with animated intensity transitions.
// Manages its own shader program, FBO, texture, and fullscreen quad VAO.
import { createProgram } from './shaderUtils';

// ── Shaders ──────────────────────────────────────────────────────────

const CRT_VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

const CRT_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_scene;
uniform float u_time;
uniform float u_intensity;
uniform vec2 u_resolution;
uniform float u_phosphor;
in vec2 v_uv;
out vec4 fragColor;

// P1 phosphor green color matrix (matches CSS feColorMatrix)
vec3 phosphorGreen(vec3 c) {
  return vec3(
    0.06 * c.r + 0.117 * c.g + 0.023 * c.b,
    0.449 * c.r + 0.881 * c.g + 0.171 * c.b,
    0.0
  );
}

void main() {
  vec2 uv = v_uv;

  // Barrel distortion scaled by intensity
  vec2 cc = uv - 0.5;
  uv = uv + cc * dot(cc, cc) * 0.04 * u_intensity;

  // Out-of-bounds → black (only possible when distortion is active)
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Chromatic aberration scaled by intensity
  float aberration = 0.8 / u_resolution.x * u_intensity;
  float r = texture(u_scene, vec2(uv.x + aberration, uv.y)).r;
  float g = texture(u_scene, uv).g;
  float b = texture(u_scene, vec2(uv.x - aberration, uv.y)).b;
  vec3 col = vec3(r, g, b);

  // Scanlines — lerp between 1.0 (no effect) and scanline value
  float scanRaw = 0.92 + 0.08 * sin(uv.y * u_resolution.y * 3.14159 + u_time * 30.0);
  float scanline = mix(1.0, scanRaw, u_intensity);
  col *= scanline;

  // Phosphor glow scaled by intensity
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col += col * smoothstep(0.4, 0.8, lum) * 0.15 * u_intensity;

  // Vignette — lerp between 1.0 (no darkening) and vignette value
  vec2 vig = uv * (1.0 - uv);
  float vigVal = pow(vig.x * vig.y * 15.0, 0.15);
  col *= mix(1.0, vigVal, u_intensity);

  // Phosphor green color matrix
  if (u_phosphor > 0.5) {
    col = phosphorGreen(col);
  }

  fragColor = vec4(col, 1.0);
}
`;

// ── CRTEffect class ─────────────────────────────────────────────────

const TRANSITION_MS = 400;

export class CRTEffect {
  private _enabled = false;
  private _program: WebGLProgram | null = null;
  private _fbo: WebGLFramebuffer | null = null;
  private _texture: WebGLTexture | null = null;
  private _vao: WebGLVertexArrayObject | null = null;
  private _uniforms: {
    scene: WebGLUniformLocation;
    time: WebGLUniformLocation;
    intensity: WebGLUniformLocation;
    resolution: WebGLUniformLocation;
    phosphor: WebGLUniformLocation;
  } | null = null;
  private _phosphor = false;
  private _startTime = 0;

  // Transition state
  private _intensity = 0;
  private _targetIntensity = 0;
  private _transitionStart = 0;
  private _transitionFrom = 0;

  constructor(
    private gl: WebGL2RenderingContext,
    private canvas: HTMLCanvasElement,
  ) {}

  /** True when the CRT pass should run (enabled or mid-transition). */
  get active(): boolean {
    return this._enabled || this._intensity !== this._targetIntensity;
  }

  /**
   * Enable or disable the CRT effect.
   * @param animate - When true and the renderer has content, smoothly transitions.
   *                  When false, sets intensity instantly (e.g. initial load).
   * @param hasContent - Whether the renderer has rendered at least one frame.
   */
  setEnabled(enabled: boolean, animate: boolean): void {
    if (animate) {
      this._transitionStart = performance.now();
      this._transitionFrom = this._intensity;
      if (enabled) {
        this._targetIntensity = 1;
        this._enabled = true;
        this.ensureResources();
      } else {
        this._targetIntensity = 0;
        // Keep _enabled = true during fade-out so the FBO pass runs
      }
    } else {
      this._intensity = enabled ? 1 : 0;
      this._targetIntensity = this._intensity;
      this._enabled = enabled;
      if (enabled) this.ensureResources();
    }
  }

  /** Enable or disable phosphor green color matrix in the CRT pass. */
  setPhosphor(enabled: boolean): void {
    this._phosphor = enabled;
  }

  /** Advance the intensity transition. Call once per frame before rendering. */
  updateTransition(): void {
    if (this._intensity === this._targetIntensity) return;
    const elapsed = performance.now() - this._transitionStart;
    const t = Math.min(elapsed / TRANSITION_MS, 1);
    // Ease-in-out cubic
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this._intensity = this._transitionFrom + (this._targetIntensity - this._transitionFrom) * eased;
    if (t >= 1) {
      this._intensity = this._targetIntensity;
      if (this._targetIntensity === 0) this._enabled = false;
    }
  }

  /** Bind the FBO so subsequent draws render to the CRT texture. */
  bindFBO(): void {
    if (!this._enabled || !this._fbo) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Returns true if the FBO is bound and the post-processing pass should run. */
  get shouldPostProcess(): boolean {
    return this._enabled && !!this._fbo && !!this._program && !!this._uniforms && !!this._vao;
  }

  /** Run the CRT post-processing pass: unbind FBO and draw fullscreen quad. */
  postProcess(): void {
    if (!this._fbo || !this._program || !this._uniforms || !this._vao) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this._program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.uniform1i(this._uniforms.scene, 0);
    gl.uniform1f(this._uniforms.time, (performance.now() - this._startTime) / 1000);
    gl.uniform1f(this._uniforms.intensity, this._intensity);
    gl.uniform2f(this._uniforms.resolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(this._uniforms.phosphor, this._phosphor ? 1.0 : 0.0);

    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  /** Resize the FBO texture to match current canvas dimensions. */
  resizeFBO(): void {
    if (!this._texture) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.canvas.width,
      this.canvas.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Release all GPU resources. */
  dispose(): void {
    const gl = this.gl;
    if (this._program) {
      gl.deleteProgram(this._program);
      this._program = null;
    }
    if (this._fbo) {
      gl.deleteFramebuffer(this._fbo);
      this._fbo = null;
    }
    if (this._texture) {
      gl.deleteTexture(this._texture);
      this._texture = null;
    }
    if (this._vao) {
      gl.deleteVertexArray(this._vao);
      this._vao = null;
    }
    this._uniforms = null;
  }

  // ── Private ──────────────────────────────────────────────────────

  private ensureResources(): void {
    if (this._program) return;
    const gl = this.gl;
    this._startTime = performance.now();

    this._program = createProgram(gl, CRT_VERT, CRT_FRAG);
    this._uniforms = {
      scene: gl.getUniformLocation(this._program, 'u_scene')!,
      time: gl.getUniformLocation(this._program, 'u_time')!,
      intensity: gl.getUniformLocation(this._program, 'u_intensity')!,
      resolution: gl.getUniformLocation(this._program, 'u_resolution')!,
      phosphor: gl.getUniformLocation(this._program, 'u_phosphor')!,
    };

    // FBO texture
    this._texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.canvas.width,
      this.canvas.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);

    // FBO
    this._fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Fullscreen quad VAO
    const quadVerts = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
    this._vao = gl.createVertexArray()!;
    gl.bindVertexArray(this._vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }
}
