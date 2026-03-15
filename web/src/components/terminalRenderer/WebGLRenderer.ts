import { CRTEffect } from './CRTEffect';
import { GlyphAtlas } from './GlyphAtlas';
import type { GlyphEntry } from './GlyphAtlas';
import { RendererMonitor } from './rendererDebug';
import type { RendererDebugContext } from './rendererDebug';
import { createProgram } from './shaderUtils';
import {
  ANSI_PALETTE,
  CellFlags,
  type GhosttyCell,
  type IRenderable,
  type IScrollbackProvider,
  type ITheme,
  type RendererOptions,
  type SelectionManager,
  parseColor,
} from './terminalTypes';
import { getBlockAlpha, getBlockQuads } from './unicodeQuads';

// WebGL2 Glyph-Atlas Renderer for ghostty-web terminals.
// Replaces the Canvas2D CanvasRenderer with instanced drawing:
//   - Glyph atlas texture (2048x2048 RGBA) for text rasterization
//   - Background quads via instanced draw call
//   - Text quads via instanced draw call with alpha blending
//   - Decoration quads for underline/strikethrough/cursor/scrollbar

// ── Shader sources ────────────────────────────────────────────────────

const BG_VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_cellPos;
layout(location=2) in vec4 a_color;
layout(location=3) in vec2 a_size;
uniform vec2 u_cellSize;
uniform vec2 u_gridOffset;
uniform vec2 u_resolution;
out vec4 v_color;
void main() {
  vec2 scaled = a_pos * a_size;
  vec2 pos = (a_cellPos + scaled) * u_cellSize + u_gridOffset;
  // Snap to physical pixel grid
  pos = floor(pos * u_resolution + 0.5) / u_resolution;
  pos = pos * 2.0 - 1.0;
  pos.y = -pos.y;
  gl_Position = vec4(pos, 0.0, 1.0);
  v_color = a_color;
}
`;

const BG_FRAG = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }
`;

const TEXT_VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_cellPos;
layout(location=2) in vec2 a_cellSize;
layout(location=3) in vec4 a_atlasUV;
layout(location=4) in vec4 a_color;
uniform vec2 u_cellSize;
uniform vec2 u_gridOffset;
uniform vec2 u_resolution;
out vec2 v_uv;
out vec4 v_color;
void main() {
  // Compute position in normalized 0-1 space
  vec2 pos = (a_cellPos + a_pos * a_cellSize) * u_cellSize + u_gridOffset;
  // Snap to physical pixel grid to prevent subpixel blurriness
  pos = floor(pos * u_resolution + 0.5) / u_resolution;
  pos = pos * 2.0 - 1.0;
  pos.y = -pos.y;
  gl_Position = vec4(pos, 0.0, 1.0);
  v_uv = a_atlasUV.xy + a_pos * a_atlasUV.zw;
  v_color = a_color;
}
`;

const TEXT_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_atlas;
in vec2 v_uv;
in vec4 v_color;
out vec4 fragColor;
void main() {
  vec4 tex = texture(u_atlas, v_uv);
  if (v_color.a < 0.0) {
    fragColor = tex;
  } else {
    fragColor = vec4(v_color.rgb, v_color.a * tex.a);
  }
}
`;

// ── WebGLRenderer ─────────────────────────────────────────────────────

export class WebGLRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private atlas: GlyphAtlas;

  // Shader programs
  private bgProgram: WebGLProgram;
  private textProgram: WebGLProgram;

  // Uniforms
  private bgUniforms: {
    cellSize: WebGLUniformLocation;
    gridOffset: WebGLUniformLocation;
    resolution: WebGLUniformLocation;
  };
  private textUniforms: {
    cellSize: WebGLUniformLocation;
    gridOffset: WebGLUniformLocation;
    atlas: WebGLUniformLocation;
    resolution: WebGLUniformLocation;
  };

  // VAOs and buffers
  private quadVBO: WebGLBuffer;
  private bgVAO: WebGLVertexArrayObject;
  private bgInstanceVBO: WebGLBuffer;
  private textVAO: WebGLVertexArrayObject;
  private textInstanceVBO: WebGLBuffer;

  // Instance data arrays (pre-allocated, grown as needed)
  private bgData: Float32Array;
  private bgCount = 0;
  private textData: Float32Array;
  private textCount = 0;

  // Terminal state
  private _fontSize: number;
  private _fontFamily: string;
  private _cellWidth = 0;
  private _cellHeight = 0;
  private _baseline = 0;
  private _cols = 80;
  private _rows = 24;
  private _dpr = window.devicePixelRatio || 1;

  // Theme colors
  private themeBg: [number, number, number] = [0, 0, 0];
  private themeFg: [number, number, number] = [228, 228, 231];
  private themeCursor: [number, number, number] = [228, 228, 231];
  private themeCursorAccent: [number, number, number] = [0, 0, 0];
  private themeSelBg: [number, number, number] = [63, 63, 70];
  private themeSelFg: [number, number, number] | null = null;
  private themeColors: [number, number, number][] = [];
  private oldThemeBgs: number[] = [];
  private oldThemeFgs: number[] = [];

  // Cursor
  private _cursorStyle: 'block' | 'underline' | 'bar' = 'block';
  private _cursorBlink = true;
  cursorVisible = true;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;

  // Selection
  private selectionManager: SelectionManager | null = null;

  // Link hover
  private hoveredHyperlinkId = 0;
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;

  private disposed = false;

  // CRT post-processing (delegated to CRTEffect)
  private _crt!: CRTEffect;

  // Render monitor (delegated to RendererMonitor)
  private _monitor!: RendererMonitor;

  private _lastBuffer: IRenderable | null = null;

  private constructor(
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    options: RendererOptions,
  ) {
    this.canvas = canvas;
    this.gl = gl;
    this._fontSize = options.fontSize;
    this._fontFamily = options.fontFamily;
    this._cursorStyle = options.cursorStyle;
    this._cursorBlink = options.cursorBlink;

    // Parse theme
    this.applyTheme(options.theme);

    // Measure font
    const metrics = this._measureFont();
    this._cellWidth = metrics.width;
    this._cellHeight = metrics.height;
    this._baseline = metrics.baseline;

    // Init atlas
    this.atlas = new GlyphAtlas(gl, this._cellWidth, this._cellHeight, this._dpr);

    // CRT post-processing
    this._crt = new CRTEffect(gl, canvas);

    // Debug monitor
    this._monitor = new RendererMonitor(this._debugContext());

    // Compile shaders
    this.bgProgram = createProgram(gl, BG_VERT, BG_FRAG);
    this.textProgram = createProgram(gl, TEXT_VERT, TEXT_FRAG);

    this.bgUniforms = {
      cellSize: gl.getUniformLocation(this.bgProgram, 'u_cellSize')!,
      gridOffset: gl.getUniformLocation(this.bgProgram, 'u_gridOffset')!,
      resolution: gl.getUniformLocation(this.bgProgram, 'u_resolution')!,
    };
    this.textUniforms = {
      cellSize: gl.getUniformLocation(this.textProgram, 'u_cellSize')!,
      gridOffset: gl.getUniformLocation(this.textProgram, 'u_gridOffset')!,
      atlas: gl.getUniformLocation(this.textProgram, 'u_atlas')!,
      resolution: gl.getUniformLocation(this.textProgram, 'u_resolution')!,
    };

    // Unit quad (2 triangles)
    const quadVerts = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
    this.quadVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

    // Pre-allocate instance buffers for max cells (grown if needed)
    const maxCells = this._cols * this._rows;
    this.bgData = new Float32Array(maxCells * 8);
    this.textData = new Float32Array(maxCells * 12);

    // Create BG VAO
    this.bgVAO = gl.createVertexArray()!;
    this.bgInstanceVBO = gl.createBuffer()!;
    gl.bindVertexArray(this.bgVAO);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.bgData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 32, 24);
    gl.vertexAttribDivisor(3, 1);

    // Create Text VAO
    this.textVAO = gl.createVertexArray()!;
    this.textInstanceVBO = gl.createBuffer()!;
    gl.bindVertexArray(this.textVAO);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.textInstanceVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.textData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 48, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 48, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 48, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, 48, 32);
    gl.vertexAttribDivisor(4, 1);

    gl.bindVertexArray(null);

    // Start cursor blink
    if (this._cursorBlink) {
      this.startBlink();
    }
  }

  private _debugContext(): RendererDebugContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get gl() {
        return self.gl;
      },
      get canvas() {
        return self.canvas;
      },
      get themeBg() {
        return self.themeBg;
      },
      get themeFg() {
        return self.themeFg;
      },
      get themeColors() {
        return self.themeColors;
      },
      get cellWidth() {
        return self._cellWidth;
      },
      get cellHeight() {
        return self._cellHeight;
      },
      get dpr() {
        return self._dpr;
      },
      get cols() {
        return self._cols;
      },
      get rows() {
        return self._rows;
      },
      get lastBuffer() {
        return self._lastBuffer;
      },
      render: (buffer: IRenderable, forceAll: boolean, viewportY: number) => {
        self.render(buffer, forceAll, viewportY);
      },
    };
  }

  static create(existingCanvas: HTMLCanvasElement, options: RendererOptions): WebGLRenderer | null {
    const canvas = document.createElement('canvas');
    canvas.width = existingCanvas.width;
    canvas.height = existingCanvas.height;
    canvas.style.cssText = existingCanvas.style.cssText;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) return null;
    try {
      existingCanvas.parentElement?.replaceChild(canvas, existingCanvas);
      return new WebGLRenderer(canvas, gl, options);
    } catch (e) {
      console.warn('[WebGLRenderer] init failed, falling back to Canvas2D:', e);
      if (canvas.parentElement) {
        canvas.parentElement.replaceChild(existingCanvas, canvas);
      }
      return null;
    }
  }

  // ── Font metrics ──────────────────────────────────────────────────

  private _measureFont(): { width: number; height: number; baseline: number } {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${this._fontSize}px ${this._fontFamily}`;
    const tm = ctx.measureText('M');
    const ascent = tm.fontBoundingBoxAscent ?? tm.actualBoundingBoxAscent ?? this._fontSize * 0.8;
    const descent =
      tm.fontBoundingBoxDescent ?? tm.actualBoundingBoxDescent ?? this._fontSize * 0.2;
    const dpr = window.devicePixelRatio || 1;
    return {
      width: Math.round(tm.width * dpr) / dpr,
      height: Math.round((ascent + descent) * dpr) / dpr,
      baseline: Math.round(ascent * dpr) / dpr,
    };
  }

  measureFont(): { width: number; height: number; baseline: number } {
    return this._measureFont();
  }

  remeasureFont(): void {
    const m = this._measureFont();
    this._cellWidth = m.width;
    this._cellHeight = m.height;
    this._baseline = m.baseline;
    this.atlas.reset(this._cellWidth, this._cellHeight, this._dpr);
    this.resizeCanvas();
  }

  get fontSize(): number {
    return this._fontSize;
  }
  set fontSize(v: number) {
    this._fontSize = v;
  }

  get fontFamily(): string {
    return this._fontFamily;
  }
  set fontFamily(v: string) {
    this._fontFamily = v;
  }

  getMetrics(): { width: number; height: number; baseline: number } {
    return { width: this._cellWidth, height: this._cellHeight, baseline: this._baseline };
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  get charWidth(): number {
    return this._cellWidth;
  }
  get charHeight(): number {
    return this._cellHeight;
  }

  // ── Configuration setters ─────────────────────────────────────────

  setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  setFontSize(size: number): void {
    this._fontSize = size;
    this.remeasureFont();
  }

  setFontFamily(family: string): void {
    this._fontFamily = family;
    this.remeasureFont();
  }

  setTheme(theme: ITheme): void {
    this.oldThemeBgs.push(this.themeBg[0], this.themeBg[1], this.themeBg[2]);
    this.oldThemeFgs.push(this.themeFg[0], this.themeFg[1], this.themeFg[2]);
    this.applyTheme(theme);
  }

  setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this._cursorStyle = style;
  }

  setCursorBlink(enabled: boolean): void {
    this._cursorBlink = enabled;
    if (enabled) {
      this.startBlink();
    } else {
      this.stopBlink();
      this.cursorVisible = true;
    }
  }

  setHoveredHyperlinkId(id: number): void {
    this.hoveredHyperlinkId = id;
  }

  setHoveredLinkRange(
    range: { startX: number; startY: number; endX: number; endY: number } | null,
  ): void {
    const changed = JSON.stringify(this.hoveredLinkRange) !== JSON.stringify(range);
    this.hoveredLinkRange = range;
    if (changed && this._lastBuffer) {
      this.render(this._lastBuffer, true, 0);
    }
  }

  resize(_cols: number, _rows: number): void {
    this._cols = _cols;
    this._rows = _rows;
    this.ensureBufferCapacity();
    this.resizeCanvas();
  }

  // ── Theme ─────────────────────────────────────────────────────────

  private applyTheme(theme: ITheme): void {
    this.themeBg = parseColor(theme.background, [0, 0, 0]);
    this.themeFg = parseColor(theme.foreground, [228, 228, 231]);
    this.themeCursor = parseColor(theme.cursor, this.themeFg);
    this.themeCursorAccent = parseColor(theme.cursorAccent, this.themeBg);
    this.themeSelBg = parseColor(theme.selectionBackground, [63, 63, 70]);
    this.themeSelFg = theme.selectionForeground
      ? parseColor(theme.selectionForeground, this.themeFg)
      : null;

    this.themeColors = [
      parseColor(theme.black, [9, 9, 11]),
      parseColor(theme.red, [239, 68, 68]),
      parseColor(theme.green, [34, 197, 94]),
      parseColor(theme.yellow, [234, 179, 8]),
      parseColor(theme.blue, [59, 130, 246]),
      parseColor(theme.magenta, [168, 85, 247]),
      parseColor(theme.cyan, [6, 182, 212]),
      parseColor(theme.white, [228, 228, 231]),
      parseColor(theme.brightBlack, [82, 82, 91]),
      parseColor(theme.brightRed, [248, 113, 113]),
      parseColor(theme.brightGreen, [74, 222, 128]),
      parseColor(theme.brightYellow, [250, 204, 21]),
      parseColor(theme.brightBlue, [96, 165, 250]),
      parseColor(theme.brightMagenta, [192, 132, 252]),
      parseColor(theme.brightCyan, [34, 211, 238]),
      parseColor(theme.brightWhite, [250, 250, 250]),
    ];

    for (let i = 0; i < 16; i++) {
      ANSI_PALETTE[i] = this.themeColors[i];
    }
  }

  private isOldThemeBg(r: number, g: number, b: number): boolean {
    const a = this.oldThemeBgs;
    for (let i = 0; i < a.length; i += 3) {
      if (a[i] === r && a[i + 1] === g && a[i + 2] === b) return true;
    }
    return false;
  }

  private isOldThemeFg(r: number, g: number, b: number): boolean {
    const a = this.oldThemeFgs;
    for (let i = 0; i < a.length; i += 3) {
      if (a[i] === r && a[i + 1] === g && a[i + 2] === b) return true;
    }
    return false;
  }

  // ── Cursor blink ──────────────────────────────────────────────────

  private startBlink(): void {
    this.stopBlink();
    this.cursorVisible = true;
    this.blinkTimer = setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
    }, 530);
  }

  private stopBlink(): void {
    if (this.blinkTimer !== null) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
  }

  // ── Canvas / buffer management ────────────────────────────────────

  private resizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.ceil(this._cols * this._cellWidth);
    const h = Math.ceil(this._rows * this._cellHeight);
    this.canvas.width = Math.ceil(w * dpr);
    this.canvas.height = Math.ceil(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (this._crt.active) this._crt.resizeFBO();
  }

  // ── CRT post-processing ──────────────────────────────────────────

  get crtActive(): boolean {
    return this._crt.active;
  }

  setCRTEnabled(enabled: boolean, animate = true): void {
    const shouldAnimate = animate && !!this._lastBuffer;
    this._crt.setEnabled(enabled, shouldAnimate);
    if (shouldAnimate && enabled && this._lastBuffer) {
      this.render(this._lastBuffer, true, 0);
    }
  }

  setPhosphor(enabled: boolean): void {
    this._crt.setPhosphor(enabled);
  }

  private ensureBufferCapacity(): void {
    const maxCells = this._cols * this._rows;
    if (this.bgData.length < maxCells * 8) {
      this.bgData = new Float32Array(maxCells * 8);
    }
    if (this.textData.length < maxCells * 12) {
      this.textData = new Float32Array(maxCells * 12);
    }
  }

  // ── Selection helpers ─────────────────────────────────────────────

  private isSelected(col: number, row: number): boolean {
    if (!this.selectionManager) return false;
    const sel = this.selectionManager.getSelectionCoords();
    if (!sel) return false;

    const { startCol, startRow, endCol, endRow } = sel;
    if (startRow === endRow) {
      return row === startRow && col >= startCol && col < endCol;
    }
    if (row === startRow) return col >= startCol;
    if (row === endRow) return col < endCol;
    return row > startRow && row < endRow;
  }

  // ── Decoration quad helpers ───────────────────────────────────────

  private addBgQuad(
    col: number,
    row: number,
    w: number,
    r: number,
    g: number,
    b: number,
    a: number,
    h = 1.0,
  ): void {
    const i = this.bgCount * 8;
    if (i + 8 > this.bgData.length) {
      const next = new Float32Array(this.bgData.length * 2);
      next.set(this.bgData);
      this.bgData = next;
    }
    this.bgData[i] = col;
    this.bgData[i + 1] = row;
    this.bgData[i + 2] = r / 255;
    this.bgData[i + 3] = g / 255;
    this.bgData[i + 4] = b / 255;
    this.bgData[i + 5] = a;
    this.bgData[i + 6] = w;
    this.bgData[i + 7] = h;
    this.bgCount++;
  }

  private addTextQuad(
    col: number,
    row: number,
    cw: number,
    ch: number,
    glyph: GlyphEntry,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    const i = this.textCount * 12;
    if (i + 12 > this.textData.length) {
      const next = new Float32Array(this.textData.length * 2);
      next.set(this.textData);
      this.textData = next;
    }
    this.textData[i] = col;
    this.textData[i + 1] = row;
    this.textData[i + 2] = cw;
    this.textData[i + 3] = ch;
    this.textData[i + 4] = glyph.u;
    this.textData[i + 5] = glyph.v;
    this.textData[i + 6] = glyph.w;
    this.textData[i + 7] = glyph.h;
    this.textData[i + 8] = r / 255;
    this.textData[i + 9] = g / 255;
    this.textData[i + 10] = b / 255;
    this.textData[i + 11] = a;
    this.textCount++;
  }

  // ── Monitor delegates ─────────────────────────────────────────────

  startMonitor(withPixelCheck = false): void {
    this._monitor.startMonitor(withPixelCheck);
  }
  stopMonitor() {
    return this._monitor.stopMonitor();
  }
  recordWrite(byteCount: number): void {
    this._monitor.recordWrite(byteCount);
  }
  dumpFrame(frameIdx: number): void {
    this._monitor.dumpFrame(frameIdx);
  }
  liveCheck(buffer?: IRenderable): void {
    this._monitor.liveCheck(buffer);
  }
  dumpCells(buffer?: IRenderable): string[] {
    return this._monitor.dumpCells(buffer);
  }
  dumpViewportVsLine(buffer?: IRenderable): string[] {
    return this._monitor.dumpViewportVsLine(buffer);
  }
  verifyFrame(buffer?: IRenderable): { summary: string; errors: string[] } {
    return this._monitor.verifyFrame(buffer);
  }
  pixelCheck(buffer?: IRenderable): string[] {
    return this._monitor.pixelCheck(buffer);
  }

  // ── Main render ───────────────────────────────────────────────────

  render(
    buffer: IRenderable,
    _forceAll?: boolean,
    viewportY?: number,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity?: number,
  ): void {
    if (this.disposed) return;
    this._lastBuffer = buffer;
    this._crt.updateTransition();
    const gl = this.gl;

    // DPR change detection
    const currentDpr = window.devicePixelRatio || 1;
    if (currentDpr !== this._dpr) {
      this._dpr = currentDpr;
      this.remeasureFont();
    }

    const dims = buffer.getDimensions();
    if (dims.cols !== this._cols || dims.rows !== this._rows) {
      this._cols = dims.cols;
      this._rows = dims.rows;
      this.ensureBufferCapacity();
      this.resizeCanvas();
    }

    const vp = viewportY || 0;
    const scrollbackLen = scrollbackProvider?.getScrollbackLength() || 0;
    const vpFloor = Math.floor(vp);

    // Read viewport cells as a deep-copied snapshot.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bufAny = buffer as any;
    let viewportCells: GhosttyCell[] | null = null;
    if (vp === 0 && typeof bufAny.getViewport === 'function') {
      const pool = bufAny.getViewport() as GhosttyCell[];
      const total = this._cols * this._rows;
      viewportCells = new Array(total);
      for (let i = 0; i < total; i++) {
        const c = pool[i];
        viewportCells[i] = {
          codepoint: c.codepoint,
          fg_r: c.fg_r,
          fg_g: c.fg_g,
          fg_b: c.fg_b,
          bg_r: c.bg_r,
          bg_g: c.bg_g,
          bg_b: c.bg_b,
          flags: c.flags,
          width: c.width,
          hyperlink_id: c.hyperlink_id,
          grapheme_len: c.grapheme_len,
        };
      }
    }

    // Monitor: capture viewport data snapshot
    if (this._monitor.enabled && viewportCells) {
      this._monitor.captureFrame(viewportCells);
    }

    const bgR = this.themeBg[0],
      bgG = this.themeBg[1],
      bgB = this.themeBg[2];

    // Build instances for all rows.
    let atlasEvictionsBefore = this.atlas.evictionCount;
    for (let pass = 0; pass < 3; pass++) {
      this.bgCount = 0;
      this.textCount = 0;

      for (let row = 0; row < this._rows; row++) {
        let line: GhosttyCell[] | null = null;

        if (vp > 0) {
          if (row < vp && scrollbackProvider) {
            const scrollOffset = scrollbackLen - vpFloor + row;
            if (scrollOffset >= 0) {
              line = scrollbackProvider.getScrollbackLine(scrollOffset);
            }
          } else {
            const bufRow = row - vpFloor;
            if (bufRow >= 0) {
              line = buffer.getLine(bufRow);
            }
          }
        } else if (viewportCells) {
          const start = row * this._cols;
          line = viewportCells.slice(start, start + this._cols);
        } else {
          line = buffer.getLine(row);
        }

        if (!line) continue;

        for (let col = 0; col < line.length && col < this._cols; col++) {
          const cell = line[col];
          if (cell.width === 0) continue;

          const flags = cell.flags;
          const inverse = (flags & CellFlags.INVERSE) !== 0;
          const invisible = (flags & CellFlags.INVISIBLE) !== 0;
          const bold = (flags & CellFlags.BOLD) !== 0;
          const italic = (flags & CellFlags.ITALIC) !== 0;
          const underline = (flags & CellFlags.UNDERLINE) !== 0;
          const strikethrough = (flags & CellFlags.STRIKETHROUGH) !== 0;
          const faint = (flags & CellFlags.FAINT) !== 0;

          let cellBgR = cell.bg_r,
            cellBgG = cell.bg_g,
            cellBgB = cell.bg_b;
          let cellFgR = cell.fg_r,
            cellFgG = cell.fg_g,
            cellFgB = cell.fg_b;

          if (
            (cellFgR === 0 && cellFgG === 0 && cellFgB === 0) ||
            this.isOldThemeFg(cellFgR, cellFgG, cellFgB)
          ) {
            cellFgR = this.themeFg[0];
            cellFgG = this.themeFg[1];
            cellFgB = this.themeFg[2];
          }
          if (
            (cellBgR === 0 && cellBgG === 0 && cellBgB === 0) ||
            this.isOldThemeBg(cellBgR, cellBgG, cellBgB)
          ) {
            cellBgR = bgR;
            cellBgG = bgG;
            cellBgB = bgB;
          }

          if (inverse) {
            const tr = cellFgR,
              tg = cellFgG,
              tb = cellFgB;
            cellFgR = cellBgR;
            cellFgG = cellBgG;
            cellFgB = cellBgB;
            cellBgR = tr;
            cellBgG = tg;
            cellBgB = tb;
          }

          // Selection override
          const selected = this.isSelected(col, row);
          if (selected) {
            cellBgR = this.themeSelBg[0];
            cellBgG = this.themeSelBg[1];
            cellBgB = this.themeSelBg[2];
            if (this.themeSelFg) {
              cellFgR = this.themeSelFg[0];
              cellFgG = this.themeSelFg[1];
              cellFgB = this.themeSelFg[2];
            }
          }

          // Link hover underline
          const isHoveredLink =
            (cell.hyperlink_id > 0 && cell.hyperlink_id === this.hoveredHyperlinkId) ||
            (this.hoveredLinkRange &&
              row >= this.hoveredLinkRange.startY &&
              row <= this.hoveredLinkRange.endY &&
              (row > this.hoveredLinkRange.startY || col >= this.hoveredLinkRange.startX) &&
              (row < this.hoveredLinkRange.endY || col < this.hoveredLinkRange.endX));

          // BG quad (skip if matches theme background)
          if (cellBgR !== bgR || cellBgG !== bgG || cellBgB !== bgB) {
            this.addBgQuad(col, row, cell.width, cellBgR, cellBgG, cellBgB, 1);
          }

          // Text glyph (or geometric block element)
          if (cell.codepoint > 32 && !invisible) {
            const blockQuads = getBlockQuads(cell.codepoint);
            if (blockQuads) {
              const alpha = faint ? 0.5 : getBlockAlpha(cell.codepoint);
              for (const [bx, by, bw, bh] of blockQuads) {
                this.addBgQuad(col + bx, row + by, bw, cellFgR, cellFgG, cellFgB, alpha, bh);
              }
            } else {
              const grapheme =
                cell.grapheme_len > 0 && buffer.getGraphemeString
                  ? buffer.getGraphemeString(row, col)
                  : null;
              const wide = cell.width === 2;
              const glyph = this.atlas.getGlyph(
                cell.codepoint,
                grapheme,
                bold,
                italic,
                wide,
                this._fontSize,
                this._fontFamily,
                this._baseline,
              );
              const alpha = glyph.isColor ? -1.0 : faint ? 0.5 : 1.0;
              this.addTextQuad(col, row, wide ? 2 : 1, 1, glyph, cellFgR, cellFgG, cellFgB, alpha);
            }
          }

          // Underline decoration
          if (underline || isHoveredLink) {
            this.addBgQuad(col, row + 0.92, 1, cellFgR, cellFgG, cellFgB, 1, 0.08);
          }

          // Strikethrough decoration
          if (strikethrough) {
            this.addBgQuad(col, row + 0.45, 1, cellFgR, cellFgG, cellFgB, 1, 0.08);
          }
        }
      }

      // Cursor — hide when scrolled into scrollback
      const cursor = buffer.getCursor();
      if (cursor.visible && this.cursorVisible && vp === 0) {
        const cx = cursor.x,
          cy = cursor.y;
        if (this._cursorStyle === 'block') {
          this.addBgQuad(
            cx,
            cy,
            1,
            this.themeCursor[0],
            this.themeCursor[1],
            this.themeCursor[2],
            1,
          );
          const cursorLine = viewportCells
            ? viewportCells.slice(cy * this._cols, (cy + 1) * this._cols)
            : buffer.getLine(cy);
          if (cursorLine && cx < cursorLine.length) {
            const cell = cursorLine[cx];
            if (cell.codepoint > 32 && !(cell.flags & CellFlags.INVISIBLE)) {
              const grapheme =
                cell.grapheme_len > 0 && buffer.getGraphemeString
                  ? buffer.getGraphemeString(cy, cx)
                  : null;
              const bold = (cell.flags & CellFlags.BOLD) !== 0;
              const italic = (cell.flags & CellFlags.ITALIC) !== 0;
              const wide = cell.width === 2;
              const glyph = this.atlas.getGlyph(
                cell.codepoint,
                grapheme,
                bold,
                italic,
                wide,
                this._fontSize,
                this._fontFamily,
                this._baseline,
              );
              this.addTextQuad(
                cx,
                cy,
                wide ? 2 : 1,
                1,
                glyph,
                this.themeCursorAccent[0],
                this.themeCursorAccent[1],
                this.themeCursorAccent[2],
                1,
              );
            }
          }
        } else if (this._cursorStyle === 'bar') {
          this.addBgQuad(
            cx,
            cy,
            1,
            this.themeCursor[0],
            this.themeCursor[1],
            this.themeCursor[2],
            1,
          );
        } else {
          this.addBgQuad(
            cx,
            cy + 0.9,
            1,
            this.themeCursor[0],
            this.themeCursor[1],
            this.themeCursor[2],
            1,
            0.1,
          );
        }
      }

      // Scrollbar
      if (scrollbarOpacity && scrollbarOpacity > 0 && scrollbackLen > 0) {
        const totalRows = scrollbackLen + this._rows;
        const thumbFrac = this._rows / totalRows;
        const thumbH = Math.max(thumbFrac * this._rows, 1);
        const scrollFrac = (scrollbackLen - vp) / totalRows;
        const thumbY = scrollFrac * this._rows;

        const sbWidthCells = 8 / this._cellWidth;
        const sbPaddingCells = 4 / this._cellWidth;
        const sbX = this._cols - sbWidthCells - sbPaddingCells;

        const opacity = Math.min(scrollbarOpacity, 1);
        for (let sy = 0; sy < Math.ceil(thumbH); sy++) {
          const y = thumbY + sy;
          if (y < this._rows) {
            this.addBgQuad(sbX, y, 1, 128, 128, 128, opacity * 0.5);
          }
        }
      }

      if (this.atlas.evictionCount !== atlasEvictionsBefore) {
        console.warn(`[WebGL] Atlas evicted on pass ${pass}, restarting instance build`);
        atlasEvictionsBefore = this.atlas.evictionCount;
        continue;
      }
      break;
    } // end retry loop

    // ── Draw ──────────────────────────────────────────────────────

    // Bind CRT FBO if enabled — scene renders to texture
    this._crt.bindFBO();

    // Clear with theme background
    gl.clearColor(bgR / 255, bgG / 255, bgB / 255, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const cellSizeX = this._cellWidth / (this._cols * this._cellWidth);
    const cellSizeY = this._cellHeight / (this._rows * this._cellHeight);

    // Draw BG quads
    if (this.bgCount > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(this.bgProgram);
      gl.uniform2f(this.bgUniforms.cellSize, cellSizeX, cellSizeY);
      gl.uniform2f(this.bgUniforms.gridOffset, 0, 0);
      gl.uniform2f(this.bgUniforms.resolution, this.canvas.width, this.canvas.height);

      gl.bindVertexArray(this.bgVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBO);
      gl.bufferData(gl.ARRAY_BUFFER, this.bgData.subarray(0, this.bgCount * 8), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.bgCount);

      gl.disable(gl.BLEND);
    }

    // Draw Text quads
    if (this.textCount > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(this.textProgram);
      gl.uniform2f(this.textUniforms.cellSize, cellSizeX, cellSizeY);
      gl.uniform2f(this.textUniforms.gridOffset, 0, 0);
      gl.uniform2f(this.textUniforms.resolution, this.canvas.width, this.canvas.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlas.getTexture());
      gl.uniform1i(this.textUniforms.atlas, 0);

      gl.bindVertexArray(this.textVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.textInstanceVBO);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.textData.subarray(0, this.textCount * 12),
        gl.DYNAMIC_DRAW,
      );
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.textCount);

      gl.disable(gl.BLEND);
    }

    gl.bindVertexArray(null);

    // CRT post-processing pass
    if (this._crt.shouldPostProcess) {
      this._crt.postProcess();
    }

    // Monitor: pixel spot-check after draw
    if (this._monitor.enabled && this._monitor.pixelCheckEnabled && viewportCells) {
      this._monitor.pixelSpotCheck(viewportCells);
    }

    // Clear dirty state
    buffer.clearDirty();
    this.selectionManager?.clearDirtySelectionRows();
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopBlink();
    const gl = this.gl;
    gl.deleteProgram(this.bgProgram);
    gl.deleteProgram(this.textProgram);
    gl.deleteBuffer(this.quadVBO);
    gl.deleteBuffer(this.bgInstanceVBO);
    gl.deleteBuffer(this.textInstanceVBO);
    gl.deleteVertexArray(this.bgVAO);
    gl.deleteVertexArray(this.textVAO);
    this.atlas.dispose();
    this._crt.dispose();
  }

  clear(): void {
    if (this.disposed) return;
    const gl = this.gl;
    gl.clearColor(this.themeBg[0] / 255, this.themeBg[1] / 255, this.themeBg[2] / 255, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}
