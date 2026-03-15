// ── Renderer debug/monitor tools ─────────────────────────────────────
import type { GhosttyCell, IRenderable } from './terminalTypes';

export interface RendererDebugContext {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  themeBg: readonly [number, number, number];
  themeFg: readonly [number, number, number];
  themeColors: readonly [number, number, number][];
  cellWidth: number;
  cellHeight: number;
  dpr: number;
  cols: number;
  rows: number;
  lastBuffer: IRenderable | null;
  render(buffer: IRenderable, forceAll: boolean, viewportY: number): void;
}

export class RendererMonitor {
  private _enabled = false;
  private _frameCount = 0;
  private _log: Array<{
    frame: number;
    time: number;
    writesSince: number;
    rowFingerprints: string[];
    rowBgSamples: string[];
    pixelMismatches: string[];
  }> = [];
  private _writesSinceRender = 0;
  private _maxFrames = 300;
  private _pixelCheck = false;

  constructor(private ctx: RendererDebugContext) {}

  // ── Monitor lifecycle ──────────────────────────────────────────────

  startMonitor(withPixelCheck = false): void {
    this._enabled = true;
    this._pixelCheck = withPixelCheck;
    this._frameCount = 0;
    this._log = [];
    this._writesSinceRender = 0;
    console.log(
      `[Monitor] Started (pixelCheck=${withPixelCheck}). Reproduce corruption, then __renderer.stopMonitor()`,
    );
  }

  stopMonitor(): typeof this._log {
    this._enabled = false;
    const log = this._log;
    console.log(
      `[Monitor] Stopped: ${log.length} frames captured over ${this._frameCount} render calls`,
    );

    // Analyze for corruption patterns
    let anomalies = 0;
    for (let i = 1; i < log.length; i++) {
      const prev = log[i - 1];
      const curr = log[i];
      for (let r = 1; r < curr.rowFingerprints.length - 1; r++) {
        const above = curr.rowFingerprints[r - 1];
        const here = curr.rowFingerprints[r];
        const below = curr.rowFingerprints[r + 1];
        if (here.length > 0) {
          const prevIdx = prev.rowFingerprints.indexOf(here);
          if (prevIdx >= 0 && prevIdx !== r) {
            const aboveInPrev = prev.rowFingerprints.indexOf(above);
            const belowInPrev = prev.rowFingerprints.indexOf(below);
            if (aboveInPrev !== prevIdx - 1 || belowInPrev !== prevIdx + 1) {
              anomalies++;
              if (anomalies <= 10) {
                console.warn(
                  `[Monitor] Frame ${curr.frame} row ${r}: content "${here.slice(0, 30)}" was at row ${prevIdx} in frame ${prev.frame} — possible stale/mixed data`,
                );
              }
            }
          }
        }
      }
    }

    // Check pixel mismatches
    let pixelIssues = 0;
    for (const entry of log) {
      if (entry.pixelMismatches.length > 0) {
        pixelIssues += entry.pixelMismatches.length;
        if (pixelIssues <= 5) {
          for (const m of entry.pixelMismatches) {
            console.warn(`[Monitor] Frame ${entry.frame}: ${m}`);
          }
        }
      }
    }

    if (anomalies === 0 && pixelIssues === 0) {
      console.log('[Monitor] No anomalies detected in captured frames');
    } else {
      console.log(`[Monitor] Found ${anomalies} data anomalies, ${pixelIssues} pixel mismatches`);
    }
    return log;
  }

  recordWrite(byteCount: number): void {
    this._writesSinceRender += byteCount;
  }

  get enabled(): boolean {
    return this._enabled;
  }
  get pixelCheckEnabled(): boolean {
    return this._pixelCheck;
  }

  // ── Frame capture (called during render) ───────────────────────────

  captureFrame(viewportCells: GhosttyCell[]): void {
    const { rows, cols } = this.ctx;
    const rowFingerprints: string[] = [];
    const rowBgSamples: string[] = [];

    for (let r = 0; r < rows; r++) {
      let text = '';
      let bgSample = '';
      const start = r * cols;
      for (let c = 0; c < cols && c < 60; c++) {
        const cell = viewportCells[start + c];
        if (cell.width === 0) continue;
        text += cell.codepoint > 32 ? String.fromCodePoint(cell.codepoint) : ' ';
        if (!bgSample && (cell.bg_r !== 0 || cell.bg_g !== 0 || cell.bg_b !== 0)) {
          bgSample = `${cell.bg_r},${cell.bg_g},${cell.bg_b}`;
        }
      }
      rowFingerprints.push(text.trimEnd());
      rowBgSamples.push(bgSample);
    }

    const entry = {
      frame: this._frameCount,
      time: performance.now(),
      writesSince: this._writesSinceRender,
      rowFingerprints,
      rowBgSamples,
      pixelMismatches: [] as string[],
    };
    this._log.push(entry);
    this._writesSinceRender = 0;
    this._frameCount++;

    if (this._log.length > this._maxFrames) {
      this._log.shift();
    }

    // Quick intra-frame check: look for bg color discontinuities.
    let prevBg = '';
    let colorRuns = 0;
    let colorJumps = 0;
    for (let r = 0; r < rows; r++) {
      const bg = rowBgSamples[r];
      if (bg && prevBg) {
        colorRuns++;
        const [pr, pg, pb] = prevBg.split(',').map(Number);
        const [cr, cg, cb] = bg.split(',').map(Number);
        const dr = Math.abs(pr - cr),
          dg = Math.abs(pg - cg),
          db = Math.abs(pb - cb);
        if (dr > 100 || dg > 100 || db > 100) {
          colorJumps++;
        }
      }
      prevBg = bg;
    }
    if (colorRuns > 5 && colorJumps > colorRuns * 0.5) {
      console.warn(
        `[Monitor] Frame ${entry.frame}: HIGH COLOR DISCONTINUITY — ` +
          `${colorJumps}/${colorRuns} adjacent colored rows have large bg jumps. ` +
          `This may indicate row mixing/corruption in the viewport data.`,
      );
      for (let r = 0; r < Math.min(15, rows); r++) {
        if (rowBgSamples[r]) {
          console.warn(`  r${r}: bg=(${rowBgSamples[r]}) "${rowFingerprints[r].slice(0, 30)}"`);
        }
      }
    }
  }

  // ── Pixel spot-check (called after draw) ───────────────────────────

  pixelSpotCheck(viewportCells: GhosttyCell[]): void {
    const entry = this._log[this._log.length - 1];
    if (!entry) return;

    const { gl, dpr, cellWidth, cellHeight, themeBg, rows, cols } = this.ctx;
    const pixel = new Uint8Array(4);
    const bgR = themeBg[0],
      bgG = themeBg[1],
      bgB = themeBg[2];
    let mismatchCount = 0;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const c = viewportCells[row * cols + col];
        let eR = c.bg_r,
          eG = c.bg_g,
          eB = c.bg_b;
        if (eR === 0 && eG === 0 && eB === 0) continue;
        if (eR === bgR && eG === bgG && eB === bgB) continue;

        const inverse = (c.flags & 16) !== 0;
        if (inverse) {
          eR = c.fg_r;
          eG = c.fg_g;
          eB = c.fg_b;
        }

        const px = Math.floor((col + 0.5) * cellWidth * dpr);
        const py = gl.canvas.height - Math.floor((row + 0.5) * cellHeight * dpr);
        gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

        const dr = Math.abs(pixel[0] - eR);
        const dg = Math.abs(pixel[1] - eG);
        const db = Math.abs(pixel[2] - eB);

        if (dr > 10 || dg > 10 || db > 10) {
          const msg = `row${row}c${col}: data=(${eR},${eG},${eB}) pixel=(${pixel[0]},${pixel[1]},${pixel[2]}) d=${dr},${dg},${db} text="${entry.rowFingerprints[row]?.slice(0, 30)}"`;
          entry.pixelMismatches.push(msg);
          mismatchCount++;
        }
        break; // one sample per row
      }
    }

    if (mismatchCount > 0) {
      console.warn(
        `[Monitor] Frame ${entry.frame}: ${mismatchCount} pixel mismatches! Data says one thing, GPU drew another.`,
      );
      for (const m of entry.pixelMismatches.slice(0, 3)) {
        console.warn(`  ${m}`);
      }
    }
  }

  // ── Diagnostic dump methods ────────────────────────────────────────

  dumpFrame(frameIdx: number): void {
    const entry = this._log.find((e) => e.frame === frameIdx) || this._log[frameIdx];
    if (!entry) {
      console.log(`Frame ${frameIdx} not found`);
      return;
    }
    console.log(
      `Frame ${entry.frame} @ ${entry.time.toFixed(1)}ms, ${entry.writesSince} bytes written since last render`,
    );
    for (let r = 0; r < entry.rowFingerprints.length; r++) {
      const fp = entry.rowFingerprints[r];
      const bg = entry.rowBgSamples[r];
      if (fp || bg) {
        console.log(`  r${String(r).padStart(2)}: "${fp}"${bg ? ` bg=${bg}` : ''}`);
      }
    }
    if (entry.pixelMismatches.length > 0) {
      console.log('  Pixel mismatches:');
      for (const m of entry.pixelMismatches) console.log(`    ${m}`);
    }
  }

  liveCheck(buffer?: IRenderable): void {
    const { gl, dpr, cellWidth, cellHeight, themeBg, rows, cols, lastBuffer } = this.ctx;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = (buffer || lastBuffer) as any;
    if (!src || typeof src.getViewport !== 'function') {
      console.log('[liveCheck] No buffer with getViewport()');
      return;
    }

    src.update?.();
    const pool = src.getViewport() as GhosttyCell[];
    const currentRows: string[] = [];
    for (let r = 0; r < rows; r++) {
      let text = '';
      for (let c = 0; c < cols && c < 60; c++) {
        const cell = pool[r * cols + c];
        if (cell.width === 0) continue;
        text += cell.codepoint > 32 ? String.fromCodePoint(cell.codepoint) : ' ';
      }
      currentRows.push(text.trimEnd());
    }

    const lastEntry = this._log.length > 0 ? this._log[this._log.length - 1] : null;

    const pixel = new Uint8Array(4);
    const bgR = themeBg[0],
      bgG = themeBg[1],
      bgB = themeBg[2];

    console.log('[liveCheck] Current viewport vs pixels:');
    let dataVsRenderMismatches = 0;
    let dataVsMonitorMismatches = 0;

    for (let row = 0; row < rows; row++) {
      let pixelMatch = '?';
      for (let col = 0; col < cols; col++) {
        const c = pool[row * cols + col];
        let eR = c.bg_r,
          eG = c.bg_g,
          eB = c.bg_b;
        if (eR === 0 && eG === 0 && eB === 0) continue;
        if (eR === bgR && eG === bgG && eB === bgB) continue;

        const px = Math.floor((col + 0.5) * cellWidth * dpr);
        const py = gl.canvas.height - Math.floor((row + 0.5) * cellHeight * dpr);
        gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

        const dr = Math.abs(pixel[0] - eR);
        const dg = Math.abs(pixel[1] - eG);
        const db = Math.abs(pixel[2] - eB);

        if (dr > 10 || dg > 10 || db > 10) {
          pixelMatch = `PIXEL MISMATCH: data=(${eR},${eG},${eB}) screen=(${pixel[0]},${pixel[1]},${pixel[2]})`;
          dataVsRenderMismatches++;
        } else {
          pixelMatch = 'pixel ok';
        }
        break;
      }

      const monitorMatch =
        lastEntry && lastEntry.rowFingerprints[row] !== currentRows[row]
          ? `CHANGED since frame ${lastEntry.frame}`
          : '';
      if (monitorMatch) dataVsMonitorMismatches++;

      if (currentRows[row] || pixelMatch !== '?' || monitorMatch) {
        const prefix = pixelMatch.includes('MISMATCH') || monitorMatch ? '⚠️' : '  ';
        console.log(
          `${prefix} r${String(row).padStart(2)}: "${currentRows[row]}" ${pixelMatch} ${monitorMatch}`,
        );
      }
    }

    console.log(
      `\nSummary: ${dataVsRenderMismatches} pixel mismatches, ${dataVsMonitorMismatches} changed since last render`,
    );
    if (dataVsRenderMismatches > 0) {
      console.log(
        '→ Pixels differ from current data = RENDERING BUG (or data changed since last draw)',
      );
    }
    if (dataVsMonitorMismatches > 0) {
      console.log('→ Data changed since last render = viewport updated without a render frame');
    }
    if (dataVsRenderMismatches === 0 && dataVsMonitorMismatches === 0) {
      console.log(
        '→ Data and pixels agree. If corruption is visible, it may have been corrected by a new render.',
      );
      console.log('  Try: __renderer.startMonitor(true) for continuous pixel checking');
    }
  }

  dumpCells(buffer?: IRenderable): string[] {
    const { rows, cols, lastBuffer } = this.ctx;
    const src = buffer || lastBuffer;
    if (!src) return ['No buffer available. Pass buffer or call with __term.wasmTerm'];
    const lines: string[] = [];
    for (let row = 0; row < rows; row++) {
      const cells = src.getLine(row);
      if (!cells) {
        lines.push(`row ${row}: null`);
        continue;
      }
      let text = '';
      let meta = '';
      for (let col = 0; col < cells.length && col < cols; col++) {
        const c = cells[col];
        if (c.width === 0) continue;
        const ch = c.codepoint > 32 ? String.fromCodePoint(c.codepoint) : ' ';
        text += ch;
        if (c.bg_r !== 0 || c.bg_g !== 0 || c.bg_b !== 0) {
          meta += `[${col}:bg=${c.bg_r},${c.bg_g},${c.bg_b}]`;
        }
        if (c.fg_r !== 0 || c.fg_g !== 0 || c.fg_b !== 0) {
          const fgStr = `${c.fg_r},${c.fg_g},${c.fg_b}`;
          if (fgStr !== '204,204,204') {
            meta += `[${col}:fg=${fgStr}]`;
          }
        }
      }
      const trimmed = text.trimEnd();
      if (trimmed.length > 0 || meta.length > 0) {
        lines.push(`row ${row}: "${trimmed}"${meta ? ' ' + meta : ''}`);
      }
    }
    return lines;
  }

  dumpViewportVsLine(buffer?: IRenderable): string[] {
    const { rows, cols, lastBuffer } = this.ctx;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = (buffer || lastBuffer) as any;
    if (!src) return ['No buffer available'];
    if (typeof src.getViewport !== 'function') return ['Buffer has no getViewport()'];

    src.update?.();
    const vpCells: GhosttyCell[] = src.getViewport();
    const results: string[] = [];

    for (let row = 0; row < rows; row++) {
      const start = row * cols;
      let vpText = '';
      for (let col = 0; col < cols; col++) {
        const c = vpCells[start + col];
        if (!c || c.width === 0) continue;
        vpText += c.codepoint > 32 ? String.fromCodePoint(c.codepoint) : ' ';
      }

      const lineCells = src.getLine(row);
      let lineText = '';
      if (lineCells) {
        for (let col = 0; col < lineCells.length && col < cols; col++) {
          const c = lineCells[col];
          if (c.width === 0) continue;
          lineText += c.codepoint > 32 ? String.fromCodePoint(c.codepoint) : ' ';
        }
      }

      const vpTrim = vpText.trimEnd();
      const lineTrim = lineText.trimEnd();
      if (vpTrim !== lineTrim) {
        results.push(`ROW ${row} MISMATCH:`);
        results.push(`  viewport: "${vpTrim}"`);
        results.push(`  getLine:  "${lineTrim}"`);
      } else if (vpTrim.length > 0) {
        results.push(`row ${row}: "${vpTrim}" (match)`);
      }
    }
    if (results.length === 0) results.push('All rows empty');
    return results;
  }

  verifyFrame(buffer?: IRenderable): { summary: string; errors: string[] } {
    const { gl, dpr, cellWidth, cellHeight, themeBg, themeFg, rows, cols, lastBuffer } = this.ctx;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = (buffer || lastBuffer) as any;
    if (!src) return { summary: 'No buffer', errors: [] };

    // Force a render so pixels are fresh
    this.ctx.render(src, true, 0);

    src.update?.();
    const vpCells: GhosttyCell[] = typeof src.getViewport === 'function' ? src.getViewport() : null;
    if (!vpCells) return { summary: 'No getViewport', errors: [] };

    const bgR = themeBg[0],
      bgG = themeBg[1],
      bgB = themeBg[2];
    const pixel = new Uint8Array(4);
    let checked = 0,
      matched = 0;
    const errors: string[] = [];

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col += 4) {
        const c = vpCells[row * cols + col];
        if (!c || c.width === 0) continue;

        let eR = c.bg_r,
          eG = c.bg_g,
          eB = c.bg_b;
        if (eR === 0 && eG === 0 && eB === 0) {
          eR = bgR;
          eG = bgG;
          eB = bgB;
        }
        const inverse = (c.flags & 16) !== 0;
        if (inverse) {
          let fR = c.fg_r,
            fG = c.fg_g,
            fB = c.fg_b;
          if (fR === 0 && fG === 0 && fB === 0) {
            fR = themeFg[0];
            fG = themeFg[1];
            fB = themeFg[2];
          }
          eR = fR;
          eG = fG;
          eB = fB;
        }

        const px = Math.floor((col + 0.5) * cellWidth * dpr);
        const py = gl.canvas.height - Math.floor((row + 0.5) * cellHeight * dpr);
        gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

        checked++;
        const dr = Math.abs(pixel[0] - eR);
        const dg = Math.abs(pixel[1] - eG);
        const db = Math.abs(pixel[2] - eB);

        if (dr <= 5 && dg <= 5 && db <= 5) {
          matched++;
        } else if (errors.length < 20) {
          errors.push(
            `r${row}c${col}: expect(${eR},${eG},${eB}) got(${pixel[0]},${pixel[1]},${pixel[2]}) d=${dr},${dg},${db} cp=${c.codepoint}`,
          );
        }
      }
    }

    return {
      summary: `${matched}/${checked} pixels match (${errors.length} mismatches)`,
      errors,
    };
  }

  pixelCheck(buffer?: IRenderable): string[] {
    const { gl, dpr, cellWidth, cellHeight, rows, cols, lastBuffer } = this.ctx;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = (buffer || lastBuffer) as any;
    if (!src) return ['No buffer available'];

    src.update?.();
    const vpCells: GhosttyCell[] = typeof src.getViewport === 'function' ? src.getViewport() : null;
    if (!vpCells) return ['No getViewport on buffer'];

    const pixel = new Uint8Array(4);
    const results: string[] = [];
    for (let row = 0; row < rows; row++) {
      let sampleCol = -1;
      let expectedR = 0,
        expectedG = 0,
        expectedB = 0;
      for (let col = 0; col < cols; col++) {
        const c = vpCells[row * cols + col];
        if (c.bg_r !== 0 || c.bg_g !== 0 || c.bg_b !== 0) {
          sampleCol = col;
          expectedR = c.bg_r;
          expectedG = c.bg_g;
          expectedB = c.bg_b;
          break;
        }
      }
      if (sampleCol < 0) continue;

      const px = Math.floor((sampleCol + 0.5) * cellWidth * dpr);
      const py = gl.canvas.height - Math.floor((row + 0.5) * cellHeight * dpr);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

      const dr = Math.abs(pixel[0] - expectedR);
      const dg = Math.abs(pixel[1] - expectedG);
      const db = Math.abs(pixel[2] - expectedB);

      if (dr > 5 || dg > 5 || db > 5) {
        results.push(
          `row ${row} col ${sampleCol}: MISMATCH expected rgb(${expectedR},${expectedG},${expectedB}) ` +
            `got rgb(${pixel[0]},${pixel[1]},${pixel[2]}) delta=${dr},${dg},${db}`,
        );
      }
    }
    if (results.length === 0) results.push('All sampled pixels match expected bg colors');
    return results;
  }
}
