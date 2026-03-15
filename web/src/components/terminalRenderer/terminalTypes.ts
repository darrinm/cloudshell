// ── Terminal type definitions, color utilities, emoji detection ──────

export interface GhosttyCell {
  codepoint: number;
  fg_r: number;
  fg_g: number;
  fg_b: number;
  bg_r: number;
  bg_g: number;
  bg_b: number;
  flags: number;
  width: number;
  hyperlink_id: number;
  grapheme_len: number;
}

export const enum CellFlags {
  BOLD = 1,
  ITALIC = 2,
  UNDERLINE = 4,
  STRIKETHROUGH = 8,
  INVERSE = 16,
  INVISIBLE = 32,
  // BLINK = 64,
  FAINT = 128,
}

export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  getCursor(): { x: number; y: number; visible: boolean };
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  needsFullRedraw?(): boolean;
  clearDirty(): void;
  getGraphemeString?(row: number, col: number): string;
}

export interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  getScrollbackLength(): number;
}

export interface ITheme {
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface SelectionManager {
  getSelectionCoords(): {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null;
  getDirtySelectionRows(): Set<number>;
  clearDirtySelectionRows(): void;
}

export interface RendererOptions {
  fontSize: number;
  fontFamily: string;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  theme: ITheme;
}

// ── Color parsing ─────────────────────────────────────────────────────

export function parseColor(
  hex: string | undefined,
  fallback: [number, number, number],
): [number, number, number] {
  if (!hex || hex.length < 7) return fallback;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// ANSI 256-color palette (indices 0-255)
export const ANSI_PALETTE: [number, number, number][] = (() => {
  const p: [number, number, number][] = new Array(256);
  // 0-7: standard colors (filled from theme later)
  // 8-15: bright colors (filled from theme later)
  for (let i = 0; i < 16; i++) p[i] = [0, 0, 0];
  // 16-231: 6x6x6 color cube
  for (let i = 16; i < 232; i++) {
    const idx = i - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    p[i] = [r ? r * 40 + 55 : 0, g ? g * 40 + 55 : 0, b ? b * 40 + 55 : 0];
  }
  // 232-255: grayscale
  for (let i = 232; i < 256; i++) {
    const v = (i - 232) * 10 + 8;
    p[i] = [v, v, v];
  }
  return p;
})();

// ── Emoji-to-text substitution ───────────────────────────────────────
// Replace emoji characters with geometric text equivalents.
// iOS Safari renders these as glossy 3D shapes on canvas,
// while we want clean flat glyphs across all platforms.
export const EMOJI_TO_TEXT = new Map<number, number>([
  [0x1f534, 0x25cf], // 🔴 → ●
  [0x1f7e0, 0x25cf], // 🟠 → ●
  [0x1f7e1, 0x25cf], // 🟡 → ●
  [0x1f7e2, 0x25cf], // 🟢 → ●
  [0x1f535, 0x25cf], // 🔵 → ●
  [0x1f7e3, 0x25cf], // 🟣 → ●
  [0x1f7e4, 0x25cf], // 🟤 → ●
  [0x26ab, 0x25cf], // ⚫ → ●
  [0x26aa, 0x25cb], // ⚪ → ○
  [0x2733, 0x273b], // ✳️ → ✻
]);

// ── Emoji detection ──────────────────────────────────────────────────
// Detect codepoints that should use the system emoji font instead of the
// terminal's monospace font, to get Apple Color Emoji rendering.

export function isEmojiCodepoint(cp: number): boolean {
  // Miscellaneous Symbols and Pictographs, Emoticons, etc.
  if (cp >= 0x1f300 && cp <= 0x1faff) return true;
  // Supplemental Symbols and Pictographs
  if (cp >= 0x1f900 && cp <= 0x1f9ff) return true;
  // Colored squares (🟥🟧🟨🟩🟦🟪🟫)
  if (cp >= 0x1f7e0 && cp <= 0x1f7eb) return true;
  // Dingbats with emoji presentation (specific codepoints only —
  // broad range would catch text dingbats like ✦✧ that need fg color)
  if (cp === 0x2702) return true; // ✂ scissors
  if (cp >= 0x2708 && cp <= 0x270d) return true; // ✈✉✊✋✌✍
  if (cp === 0x270f) return true; // ✏ pencil
  if (cp === 0x2712) return true; // ✒ nib
  if (cp === 0x2714) return true; // ✔ checkmark
  if (cp === 0x2716) return true; // ✖ heavy multiplication
  if (cp === 0x271d) return true; // ✝ latin cross
  if (cp === 0x2721) return true; // ✡ star of david
  if (cp >= 0x2733 && cp <= 0x2734) return true; // ✳✴
  if (cp === 0x2744) return true; // ❄ snowflake
  if (cp === 0x2747) return true; // ❇ sparkle
  if (cp === 0x274c || cp === 0x274e) return true; // ❌❎
  if (cp >= 0x2753 && cp <= 0x2757) return true; // ❓❔❕❗
  if (cp >= 0x2795 && cp <= 0x2797) return true; // ➕➖➗
  if (cp === 0x27a1) return true; // ➡ right arrow
  if (cp === 0x27b0) return true; // ➰ curly loop
  // Misc symbols (⬛⬜⭐⭕ etc.)
  if (cp >= 0x2b05 && cp <= 0x2b55) return true;
  // Enclosed alphanumeric supplement (🅰🅱 etc.)
  if (cp >= 0x1f100 && cp <= 0x1f1ff) return true;
  // Transport and map symbols
  if (cp >= 0x1f680 && cp <= 0x1f6ff) return true;
  // Common individual emoji
  if (cp === 0x2764 || cp === 0x2763) return true; // ❤❣
  if (cp === 0x263a || cp === 0x2639) return true; // ☺☹
  if (cp === 0x2600 || cp === 0x2601) return true; // ☀☁
  if (cp === 0x26a0 || cp === 0x26a1) return true; // ⚠⚡
  if (cp === 0x2b50) return true; // ⭐
  // Green/colored circles and squares
  if (cp === 0x1f534 || cp === 0x1f535) return true; // 🔴🔵
  if (cp === 0x1f7e2 || cp === 0x1f7e3) return true; // 🟢🟣
  return false;
}
