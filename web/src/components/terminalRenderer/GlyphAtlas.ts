// ── Glyph Atlas ───────────────────────────────────────────────────────
import { EMOJI_TO_TEXT, isEmojiCodepoint } from './terminalTypes';

export interface GlyphEntry {
  u: number;
  v: number;
  w: number;
  h: number; // normalized UV coords
  pw: number;
  ph: number; // pixel dimensions
  isColor: boolean; // true for color emoji
}

export class GlyphAtlas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cache = new Map<string, GlyphEntry>();
  private atlasWidth = 2048;
  private atlasHeight = 2048;
  private rowX = 0;
  private rowY = 0;
  private rowHeight = 0;
  private gl: WebGL2RenderingContext;
  private texture: WebGLTexture;
  private dpr: number;
  // Incremented whenever the atlas is evicted — render loop uses this to
  // detect that UV coordinates from earlier in the frame are now invalid.
  evictionCount = 0;

  constructor(
    gl: WebGL2RenderingContext,
    private cellWidth: number,
    private cellHeight: number,
    dpr: number,
  ) {
    this.gl = gl;
    this.dpr = dpr;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.ceil(cellWidth * 2 * dpr); // wide char max
    this.canvas.height = Math.ceil(cellHeight * dpr);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;

    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // NEAREST filtering: crisp 1:1 texel-to-pixel mapping.
    // Glyphs are rasterized at DPR resolution, so atlas texels map
    // directly to physical screen pixels — no interpolation needed.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.atlasWidth,
      this.atlasHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
  }

  getTexture(): WebGLTexture {
    return this.texture;
  }

  getGlyph(
    codepoint: number,
    grapheme: string | null,
    bold: boolean,
    italic: boolean,
    wide: boolean,
    fontSize: number,
    fontFamily: string,
    baseline: number,
  ): GlyphEntry {
    // Substitute emoji circles with geometric text equivalents.
    // These render using the cell's foreground color via the text font,
    // avoiding glossy 3D emoji on iOS while keeping the color.
    const circleSubst = EMOJI_TO_TEXT.get(codepoint);
    const cp = circleSubst !== undefined ? circleSubst : codepoint;

    const key =
      grapheme && circleSubst === undefined
        ? `g:${grapheme}:${bold ? 1 : 0}:${italic ? 1 : 0}:${wide ? 1 : 0}`
        : `${cp}:${bold ? 1 : 0}:${italic ? 1 : 0}:${wide ? 1 : 0}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const dpr = this.dpr;
    const charStr = grapheme && circleSubst === undefined ? grapheme : String.fromCodePoint(cp);

    const glyphW = wide ? this.cellWidth * 2 : this.cellWidth;
    const pw = Math.ceil(glyphW * dpr);
    const ph = Math.ceil(this.cellHeight * dpr);

    // Rasterize
    const c = this.canvas;
    const ctx = this.ctx;
    c.width = pw;
    c.height = ph;
    ctx.clearRect(0, 0, pw, ph);

    let fontStyle = '';
    if (bold && italic) fontStyle = 'bold italic ';
    else if (bold) fontStyle = 'bold ';
    else if (italic) fontStyle = 'italic ';

    // Use emoji font for emoji codepoints so we get Apple Color Emoji
    // instead of the monospace font's outlined glyph.
    // Implements Ghostty's measure-constrain-render pipeline:
    //   1. Render emoji oversized to a temp canvas
    //   2. Find tight bounding box from pixel data
    //   3. Scale to fill cell (cover mode, preserve aspect ratio)
    //   4. Center with 2.5% horizontal padding, snap to pixels
    const useEmoji = isEmojiCodepoint(cp);
    if (useEmoji) {
      // Step 1: Render oversized to a temp canvas to measure bounds
      const oversizeFactor = 2;
      const emojiSize = fontSize * dpr * oversizeFactor;
      const tmpW = pw * oversizeFactor;
      const tmpH = ph * oversizeFactor;
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = tmpW;
      tmpCanvas.height = tmpH;
      const tmpCtx = tmpCanvas.getContext('2d')!;
      tmpCtx.font = `${emojiSize}px "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji"`;
      tmpCtx.textBaseline = 'alphabetic';
      tmpCtx.fillText(charStr, 0, baseline * dpr * oversizeFactor);

      // Step 2: Find tight bounding box from pixel data
      const imgData = tmpCtx.getImageData(0, 0, tmpW, tmpH);
      const pxData = imgData.data;
      let minX = tmpW,
        minY = tmpH,
        maxX = 0,
        maxY = 0;
      for (let py = 0; py < tmpH; py++) {
        for (let px2 = 0; px2 < tmpW; px2++) {
          if (pxData[(py * tmpW + px2) * 4 + 3] > 10) {
            if (px2 < minX) minX = px2;
            if (px2 > maxX) maxX = px2;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
          }
        }
      }

      const glyphBW = maxX - minX + 1;
      const glyphBH = maxY - minY + 1;

      // Step 3 & 4: Scale to fill cell and center
      c.width = pw;
      c.height = ph;
      ctx.clearRect(0, 0, pw, ph);

      if (glyphBW > 0 && glyphBH > 0) {
        const padFrac = 0.025;
        const targetW = pw * (1 - 2 * padFrac);
        const targetH = ph;
        // Cover: scale to fill, preserving aspect ratio
        const scale = Math.min(targetW / glyphBW, targetH / glyphBH);
        const drawW = Math.round(glyphBW * scale);
        const drawH = Math.round(glyphBH * scale);
        // Center and snap to pixel boundaries
        const drawX = Math.round((pw - drawW) / 2);
        const drawY = Math.round((ph - drawH) / 2);
        ctx.drawImage(tmpCanvas, minX, minY, glyphBW, glyphBH, drawX, drawY, drawW, drawH);
      } else {
        // Fallback: no visible pixels found, render directly
        ctx.font = `${fontSize * dpr}px "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji"`;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(charStr, 0, baseline * dpr);
      }
    } else {
      ctx.font = `${fontStyle}${fontSize * dpr}px ${fontFamily}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'white';
      ctx.fillText(charStr, 0, baseline * dpr);
    }

    // Detect color glyphs (emoji) by checking for non-grayscale pixels.
    // If we already used the emoji font, force isColor since some emoji
    // (like ⬛) are near-grayscale and would fail pixel sampling.
    let isColor = useEmoji;
    if (!isColor) {
      const imageData = ctx.getImageData(0, 0, pw, ph);
      const pixels = imageData.data;
      for (let j = 0; j < pixels.length; j += 16) {
        const pr = pixels[j],
          pg = pixels[j + 1],
          pb = pixels[j + 2],
          pa = pixels[j + 3];
        if (
          pa > 10 &&
          (Math.abs(pr - pg) > 10 || Math.abs(pg - pb) > 10 || Math.abs(pr - pb) > 10)
        ) {
          isColor = true;
          break;
        }
      }
    }

    // Check atlas space
    if (this.rowX + pw > this.atlasWidth) {
      this.rowX = 0;
      this.rowY += this.rowHeight + 1;
      this.rowHeight = 0;
    }
    if (this.rowY + ph > this.atlasHeight) {
      // Atlas full — evict everything and rebuild
      this.cache.clear();
      this.rowX = 0;
      this.rowY = 0;
      this.rowHeight = 0;
      this.evictionCount++;
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        this.atlasWidth,
        this.atlasHeight,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
    }

    // Upload
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, this.rowX, this.rowY, gl.RGBA, gl.UNSIGNED_BYTE, c);

    const entry: GlyphEntry = {
      u: this.rowX / this.atlasWidth,
      v: this.rowY / this.atlasHeight,
      w: pw / this.atlasWidth,
      h: ph / this.atlasHeight,
      pw,
      ph,
      isColor,
    };
    this.cache.set(key, entry);

    this.rowX += pw + 1;
    if (ph > this.rowHeight) this.rowHeight = ph;

    return entry;
  }

  reset(cellWidth: number, cellHeight: number, dpr: number) {
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.dpr = dpr;
    this.cache.clear();
    this.rowX = 0;
    this.rowY = 0;
    this.rowHeight = 0;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.atlasWidth,
      this.atlasHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
  }

  dispose() {
    this.gl.deleteTexture(this.texture);
    this.cache.clear();
  }
}
