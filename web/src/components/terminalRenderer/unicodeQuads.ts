// ── Unicode block/braille/powerline/box-drawing geometry ─────────────
// Pure lookup functions: codepoint in, quads out. Zero dependencies.

export type BlockQuad = [number, number, number, number];

export function getBlockQuads(cp: number): BlockQuad[] | null {
  // ASCII characters that should tile seamlessly across cells
  if (cp === 0x3d)
    return [
      [0, 0.38, 1, 0.09],
      [0, 0.55, 1, 0.09],
    ]; // = two horizontal lines
  if (cp === 0x5f) return [[0, 0.85, 1, 0.06]]; // _ underscore

  // Block Elements (U+2580–U+259F)
  if (cp >= 0x2580 && cp <= 0x259f) {
    switch (cp) {
      case 0x2580:
        return [[0, 0, 1, 0.5]]; // ▀ upper half
      case 0x2581:
        return [[0, 0.875, 1, 0.125]]; // ▁ lower 1/8
      case 0x2582:
        return [[0, 0.75, 1, 0.25]]; // ▂ lower 1/4
      case 0x2583:
        return [[0, 0.625, 1, 0.375]]; // ▃ lower 3/8
      case 0x2584:
        return [[0, 0.5, 1, 0.5]]; // ▄ lower half
      case 0x2585:
        return [[0, 0.375, 1, 0.625]]; // ▅ lower 5/8
      case 0x2586:
        return [[0, 0.25, 1, 0.75]]; // ▆ lower 3/4
      case 0x2587:
        return [[0, 0.125, 1, 0.875]]; // ▇ lower 7/8
      case 0x2588:
        return [[0, 0, 1, 1]]; // █ full block
      case 0x2589:
        return [[0, 0, 0.875, 1]]; // ▉ left 7/8
      case 0x258a:
        return [[0, 0, 0.75, 1]]; // ▊ left 3/4
      case 0x258b:
        return [[0, 0, 0.625, 1]]; // ▋ left 5/8
      case 0x258c:
        return [[0, 0, 0.5, 1]]; // ▌ left half
      case 0x258d:
        return [[0, 0, 0.375, 1]]; // ▍ left 3/8
      case 0x258e:
        return [[0, 0, 0.25, 1]]; // ▎ left 1/4
      case 0x258f:
        return [[0, 0, 0.125, 1]]; // ▏ left 1/8
      case 0x2590:
        return [[0.5, 0, 0.5, 1]]; // ▐ right half
      case 0x2591:
        return [[0, 0, 1, 1]]; // ░ light shade
      case 0x2592:
        return [[0, 0, 1, 1]]; // ▒ medium shade
      case 0x2593:
        return [[0, 0, 1, 1]]; // ▓ dark shade
      case 0x2594:
        return [[0, 0, 1, 0.125]]; // ▔ upper 1/8
      case 0x2595:
        return [[0.875, 0, 0.125, 1]]; // ▕ right 1/8
      // Quadrant blocks
      case 0x2596:
        return [[0, 0.5, 0.5, 0.5]]; // ▖ lower left
      case 0x2597:
        return [[0.5, 0.5, 0.5, 0.5]]; // ▗ lower right
      case 0x2598:
        return [[0, 0, 0.5, 0.5]]; // ▘ upper left
      case 0x2599:
        return [
          [0, 0, 0.5, 0.5],
          [0, 0.5, 1, 0.5],
        ]; // ▙ upper left + lower
      case 0x259a:
        return [
          [0, 0, 0.5, 0.5],
          [0.5, 0.5, 0.5, 0.5],
        ]; // ▚ upper left + lower right
      case 0x259b:
        return [
          [0, 0, 1, 0.5],
          [0, 0.5, 0.5, 0.5],
        ]; // ▛ upper + lower left
      case 0x259c:
        return [
          [0, 0, 1, 0.5],
          [0.5, 0.5, 0.5, 0.5],
        ]; // ▜ upper + lower right
      case 0x259d:
        return [[0.5, 0, 0.5, 0.5]]; // ▝ upper right
      case 0x259e:
        return [
          [0.5, 0, 0.5, 0.5],
          [0, 0.5, 0.5, 0.5],
        ]; // ▞ upper right + lower left
      case 0x259f:
        return [
          [0.5, 0, 0.5, 0.5],
          [0, 0.5, 1, 0.5],
        ]; // ▟ upper right + lower
      default:
        return null;
    }
  }

  // Box Drawing (U+2500–U+257F): render as pixel-perfect lines
  if (cp >= 0x2500 && cp <= 0x257f) {
    return getBoxDrawingQuads(cp);
  }

  // Braille Patterns (U+2800–U+28FF): render as dot grids
  if (cp >= 0x2800 && cp <= 0x28ff) {
    return getBrailleQuads(cp);
  }

  // Powerline solid triangles (U+E0B0–U+E0BE)
  if (cp >= 0xe0b0 && cp <= 0xe0bf) {
    return getPowerlineQuads(cp);
  }

  return null;
}

// ── Braille pattern rendering ───────────────────────────────────────
// Unicode braille codepoints encode dot patterns in their low byte.
// Each character is a 2-column × 4-row grid of dots.
// Bit mapping: 0=TL, 1=ML, 2=BL (6-dot), 3=TR, 4=MR, 5=BR (6-dot), 6=BL (8-dot), 7=BR (8-dot)

function getBrailleQuads(cp: number): BlockQuad[] | null {
  const pattern = cp & 0xff;
  if (pattern === 0) return null; // U+2800 = empty braille cell

  const quads: BlockQuad[] = [];
  // Dot dimensions (cell fractions) — dotH ≈ dotW * (cellW/cellH) for ~square dots
  const dw = 0.18,
    dh = 0.09;
  // Column x positions (left edge)
  const cx0 = 0.18,
    cx1 = 0.62;
  // Row y positions (top edge) — 4 rows evenly spaced
  const ry0 = 0.065,
    ry1 = 0.28,
    ry2 = 0.495,
    ry3 = 0.71;

  // Bit 0: top-left
  if (pattern & 1) quads.push([cx0, ry0, dw, dh]);
  // Bit 1: middle-left
  if (pattern & 2) quads.push([cx0, ry1, dw, dh]);
  // Bit 2: lower-left (6-dot)
  if (pattern & 4) quads.push([cx0, ry2, dw, dh]);
  // Bit 3: top-right
  if (pattern & 8) quads.push([cx1, ry0, dw, dh]);
  // Bit 4: middle-right
  if (pattern & 16) quads.push([cx1, ry1, dw, dh]);
  // Bit 5: lower-right (6-dot)
  if (pattern & 32) quads.push([cx1, ry2, dw, dh]);
  // Bit 6: bottom-left (8-dot)
  if (pattern & 64) quads.push([cx0, ry3, dw, dh]);
  // Bit 7: bottom-right (8-dot)
  if (pattern & 128) quads.push([cx1, ry3, dw, dh]);

  return quads;
}

// ── Powerline symbol rendering ───────────────────────────────────────
// Approximate powerline triangles with stacked horizontal quad slices.
// Uses ~20 slices for smooth edges at typical terminal sizes.

function getPowerlineQuads(cp: number): BlockQuad[] | null {
  const N = 20; // number of horizontal slices
  const sliceH = 1 / N;
  const quads: BlockQuad[] = [];

  switch (cp) {
    case 0xe0b0: // right-pointing solid triangle: (0,0)→(1,0.5)→(0,1)
      for (let i = 0; i < N; i++) {
        const y = i * sliceH;
        const mid = y + sliceH / 2;
        // Triangle narrows from left toward right center
        const progress = mid <= 0.5 ? mid / 0.5 : (1 - mid) / 0.5;
        const x = progress;
        quads.push([0, y, x, sliceH]);
      }
      return quads;

    case 0xe0b1: // right-pointing thin chevron (outline only)
      for (let i = 0; i < N; i++) {
        const y = i * sliceH;
        const mid = y + sliceH / 2;
        const progress = mid <= 0.5 ? mid / 0.5 : (1 - mid) / 0.5;
        const x = progress;
        quads.push([Math.max(0, x - 0.08), y, 0.08, sliceH]);
      }
      return quads;

    case 0xe0b2: // left-pointing solid triangle: (1,0)→(0,0.5)→(1,1)
      for (let i = 0; i < N; i++) {
        const y = i * sliceH;
        const mid = y + sliceH / 2;
        const progress = mid <= 0.5 ? mid / 0.5 : (1 - mid) / 0.5;
        const w = progress;
        quads.push([1 - w, y, w, sliceH]);
      }
      return quads;

    case 0xe0b3: // left-pointing thin chevron
      for (let i = 0; i < N; i++) {
        const y = i * sliceH;
        const mid = y + sliceH / 2;
        const progress = mid <= 0.5 ? mid / 0.5 : (1 - mid) / 0.5;
        const x = 1 - progress;
        quads.push([x, y, 0.08, sliceH]);
      }
      return quads;

    case 0xe0b8: // lower-left triangle: (0,0)→(0,1)→(1,1)
      for (let i = 0; i < N; i++) {
        const y = i * sliceH;
        const mid = y + sliceH / 2;
        quads.push([0, y, mid, sliceH]);
      }
      return quads;

    case 0xe0ba: // lower-right triangle: (1,0)→(0,1)→(1,1)
      for (let i = 0; i < N; i++) {
        const y = i * sliceH;
        const mid = y + sliceH / 2;
        quads.push([1 - mid, y, mid, sliceH]);
      }
      return quads;

    case 0xe0bc: // upper-left triangle: (0,0)→(1,0)→(0,1)
      for (let i = 0; i < N; i++) {
        const y = i * sliceH;
        const mid = y + sliceH / 2;
        quads.push([0, y, 1 - mid, sliceH]);
      }
      return quads;

    case 0xe0be: // upper-right triangle: (0,0)→(1,0)→(1,1)
      for (let i = 0; i < N; i++) {
        const y = i * sliceH;
        const mid = y + sliceH / 2;
        quads.push([mid, y, 1 - mid, sliceH]);
      }
      return quads;

    default:
      return null; // E0B4-E0B7 (rounded), E0B9/BB/BD/BF (diagonals) — fall to glyph
  }
}

// Box drawing line segments as geometric quads.
// Center lines: h-center = 0.45–0.55, v-center = 0.45–0.55
// Light line = 0.1 thick, heavy = 0.2 thick
const L = 0.1,
  H = 0.2;
const LC = 0.45,
  LCE = 0.55; // light center start/end (0.5 - L/2, 0.5 + L/2)
const HC = 0.4,
  HCE = 0.6; // heavy center start/end (0.5 - H/2, 0.5 + H/2)

function getBoxDrawingQuads(cp: number): BlockQuad[] | null {
  switch (cp) {
    // Single lines
    case 0x2500:
      return [[0, LC, 1, L]]; // ─ light horizontal
    case 0x2501:
      return [[0, HC, 1, H]]; // ━ heavy horizontal
    case 0x2502:
      return [[LC, 0, L, 1]]; // │ light vertical
    case 0x2503:
      return [[HC, 0, H, 1]]; // ┃ heavy vertical

    // Dashed lines (rendered as solid — dashing is decorative)
    case 0x2504:
      return [[0, LC, 1, L]]; // ┄ light triple dash h
    case 0x2505:
      return [[0, HC, 1, H]]; // ┅ heavy triple dash h
    case 0x2506:
      return [[LC, 0, L, 1]]; // ┆ light triple dash v
    case 0x2507:
      return [[HC, 0, H, 1]]; // ┇ heavy triple dash v
    case 0x2508:
      return [[0, LC, 1, L]]; // ┈ light quadruple dash h
    case 0x2509:
      return [[0, HC, 1, H]]; // ┉ heavy quadruple dash h
    case 0x250a:
      return [[LC, 0, L, 1]]; // ┊ light quadruple dash v
    case 0x250b:
      return [[HC, 0, H, 1]]; // ┋ heavy quadruple dash v

    // Light corners and tees
    case 0x250c:
      return [
        [LC, LC, LCE, L],
        [LC, LC, L, LCE],
      ]; // ┌ down-right
    case 0x250d:
      return [
        [HC, LC, HCE, L],
        [LC, LC, L, LCE],
      ]; // ┍ heavy-right down
    case 0x250e:
      return [
        [LC, HC, LCE, H],
        [HC, HC, H, HCE],
      ]; // ┎ down-heavy right
    case 0x250f:
      return [
        [HC, HC, HCE, H],
        [HC, HC, H, HCE],
      ]; // ┏ heavy down-right

    case 0x2510:
      return [
        [0, LC, LCE, L],
        [LC, LC, L, LCE],
      ]; // ┐ down-left
    case 0x2511:
      return [
        [0, LC, HCE, L],
        [LC, LC, L, LCE],
      ]; // ┑ heavy-left down
    case 0x2512:
      return [
        [0, HC, LCE, H],
        [HC, HC, H, HCE],
      ]; // ┒ down-heavy left
    case 0x2513:
      return [
        [0, HC, HCE, H],
        [HC, HC, H, HCE],
      ]; // ┓ heavy down-left

    case 0x2514:
      return [
        [LC, LC, LCE, L],
        [LC, 0, L, LCE],
      ]; // └ up-right
    case 0x2515:
      return [
        [HC, LC, HCE, L],
        [LC, 0, L, LCE],
      ]; // ┕ heavy-right up
    case 0x2516:
      return [
        [LC, HC, LCE, H],
        [HC, 0, H, HCE],
      ]; // ┖ up-heavy right
    case 0x2517:
      return [
        [HC, HC, HCE, H],
        [HC, 0, H, HCE],
      ]; // ┗ heavy up-right

    case 0x2518:
      return [
        [0, LC, LCE, L],
        [LC, 0, L, LCE],
      ]; // ┘ up-left
    case 0x2519:
      return [
        [0, LC, HCE, L],
        [LC, 0, L, LCE],
      ]; // ┙ heavy-left up
    case 0x251a:
      return [
        [0, HC, LCE, H],
        [HC, 0, H, HCE],
      ]; // ┚ up-heavy left
    case 0x251b:
      return [
        [0, HC, HCE, H],
        [HC, 0, H, HCE],
      ]; // ┛ heavy up-left

    // Tees
    case 0x251c:
      return [
        [LC, LC, LCE, L],
        [LC, 0, L, 1],
      ]; // ├ vertical-right
    case 0x251d:
      return [
        [HC, LC, HCE, L],
        [LC, 0, L, 1],
      ]; // ┝ heavy-right vertical
    case 0x251e:
      return [
        [LC, LC, LCE, L],
        [HC, 0, H, LCE],
      ]; // ┞ up-heavy right-down
    case 0x251f:
      return [
        [LC, LC, LCE, L],
        [HC, LC, H, HCE],
      ]; // ┟ down-heavy right-up
    case 0x2520:
      return [
        [LC, HC, LCE, H],
        [HC, 0, H, 1],
      ]; // ┠ heavy-vertical right
    case 0x2521:
      return [
        [HC, HC, HCE, H],
        [LC, 0, L, LCE],
      ]; // ┡ down-light heavy-right-up
    case 0x2522:
      return [
        [HC, HC, HCE, H],
        [LC, LC, L, LCE],
      ]; // ┢ up-light heavy-right-down
    case 0x2523:
      return [
        [HC, HC, HCE, H],
        [HC, 0, H, 1],
      ]; // ┣ heavy vertical-right

    case 0x2524:
      return [
        [0, LC, LCE, L],
        [LC, 0, L, 1],
      ]; // ┤ vertical-left
    case 0x2525:
      return [
        [0, LC, HCE, L],
        [LC, 0, L, 1],
      ]; // ┥ heavy-left vertical
    case 0x2526:
      return [
        [0, LC, LCE, L],
        [HC, 0, H, LCE],
      ]; // ┦ up-heavy left-down
    case 0x2527:
      return [
        [0, LC, LCE, L],
        [HC, LC, H, HCE],
      ]; // ┧ down-heavy left-up
    case 0x2528:
      return [
        [0, HC, LCE, H],
        [HC, 0, H, 1],
      ]; // ┨ heavy-vertical left
    case 0x2529:
      return [
        [0, HC, HCE, H],
        [LC, 0, L, LCE],
      ]; // ┩ down-light heavy-left-up
    case 0x252a:
      return [
        [0, HC, HCE, H],
        [LC, LC, L, LCE],
      ]; // ┪ up-light heavy-left-down
    case 0x252b:
      return [
        [0, HC, HCE, H],
        [HC, 0, H, 1],
      ]; // ┫ heavy vertical-left

    case 0x252c:
      return [
        [0, LC, 1, L],
        [LC, LC, L, LCE],
      ]; // ┬ horizontal-down
    case 0x252d:
      return [
        [0, LC, LCE, L],
        [HC, LC, HCE, L],
        [LC, LC, L, LCE],
      ]; // ┭
    case 0x252e:
      return [
        [0, LC, HCE, L],
        [LC, LC, LCE, L],
        [LC, LC, L, LCE],
      ]; // ┮
    case 0x252f:
      return [
        [0, LC, 1, L],
        [LC, LC, L, LCE],
      ]; // ┯ (simplified)
    case 0x2530:
      return [
        [0, HC, 1, H],
        [HC, HC, H, HCE],
      ]; // ┰ (simplified)
    case 0x2531:
      return [
        [0, HC, 1, H],
        [HC, HC, H, HCE],
      ]; // ┱ (simplified)
    case 0x2532:
      return [
        [0, HC, 1, H],
        [HC, HC, H, HCE],
      ]; // ┲ (simplified)
    case 0x2533:
      return [
        [0, HC, 1, H],
        [HC, HC, H, HCE],
      ]; // ┳ heavy horizontal-down

    case 0x2534:
      return [
        [0, LC, 1, L],
        [LC, 0, L, LCE],
      ]; // ┴ horizontal-up
    case 0x2535:
      return [
        [0, LC, 1, L],
        [LC, 0, L, LCE],
      ]; // ┵ (simplified)
    case 0x2536:
      return [
        [0, LC, 1, L],
        [LC, 0, L, LCE],
      ]; // ┶ (simplified)
    case 0x2537:
      return [
        [0, LC, 1, L],
        [LC, 0, L, LCE],
      ]; // ┷ (simplified)
    case 0x2538:
      return [
        [0, HC, 1, H],
        [HC, 0, H, HCE],
      ]; // ┸ (simplified)
    case 0x2539:
      return [
        [0, HC, 1, H],
        [HC, 0, H, HCE],
      ]; // ┹ (simplified)
    case 0x253a:
      return [
        [0, HC, 1, H],
        [HC, 0, H, HCE],
      ]; // ┺ (simplified)
    case 0x253b:
      return [
        [0, HC, 1, H],
        [HC, 0, H, HCE],
      ]; // ┻ heavy horizontal-up

    case 0x253c:
      return [
        [0, LC, 1, L],
        [LC, 0, L, 1],
      ]; // ┼ cross
    case 0x253d:
      return [
        [0, LC, 1, L],
        [LC, 0, L, 1],
      ]; // ┽ (simplified)
    case 0x253e:
      return [
        [0, LC, 1, L],
        [LC, 0, L, 1],
      ]; // ┾ (simplified)
    case 0x253f:
      return [
        [0, LC, 1, L],
        [LC, 0, L, 1],
      ]; // ┿ (simplified)
    case 0x2540:
      return [
        [0, LC, 1, L],
        [HC, 0, H, 1],
      ]; // ╀ (simplified)
    case 0x2541:
      return [
        [0, LC, 1, L],
        [HC, 0, H, 1],
      ]; // ╁ (simplified)
    case 0x2542:
      return [
        [0, HC, 1, H],
        [HC, 0, H, 1],
      ]; // ╂ (simplified)
    case 0x2543:
      return [
        [0, HC, 1, H],
        [HC, 0, H, 1],
      ]; // ╃ (simplified)
    case 0x2544:
      return [
        [0, HC, 1, H],
        [HC, 0, H, 1],
      ]; // ╄ (simplified)
    case 0x2545:
      return [
        [0, HC, 1, H],
        [HC, 0, H, 1],
      ]; // ╅ (simplified)
    case 0x2546:
      return [
        [0, HC, 1, H],
        [HC, 0, H, 1],
      ]; // ╆ (simplified)
    case 0x2547:
      return [
        [0, HC, 1, H],
        [HC, 0, H, 1],
      ]; // ╇ (simplified)
    case 0x2548:
      return [
        [0, HC, 1, H],
        [HC, 0, H, 1],
      ]; // ╈ (simplified)
    case 0x2549:
      return [
        [0, HC, 1, H],
        [HC, 0, H, 1],
      ]; // ╉ (simplified)
    case 0x254a:
      return [
        [0, HC, 1, H],
        [HC, 0, H, 1],
      ]; // ╊ (simplified)
    case 0x254b:
      return [
        [0, HC, 1, H],
        [HC, 0, H, 1],
      ]; // ╋ heavy cross

    // Double lines
    case 0x2550:
      return [
        [0, 0.35, 1, L],
        [0, 0.55, 1, L],
      ]; // ═ double horizontal
    case 0x2551:
      return [
        [0.35, 0, L, 1],
        [0.55, 0, L, 1],
      ]; // ║ double vertical

    case 0x2552:
      return [
        [LC, 0.35, LCE, L],
        [LC, 0.55, LCE, L],
        [LC, LC, L, LCE],
      ]; // ╒
    case 0x2553:
      return [
        [0.35, LC, LCE, L],
        [0.35, LC, L, LCE],
        [0.55, LC, L, LCE],
      ]; // ╓
    case 0x2554:
      return [
        [LC, 0.35, LCE, L],
        [LC, 0.55, LCE, L],
        [0.35, LC, L, LCE],
        [0.55, LC, L, LCE],
      ]; // ╔

    case 0x2555:
      return [
        [0, 0.35, LCE, L],
        [0, 0.55, LCE, L],
        [LC, LC, L, LCE],
      ]; // ╕
    case 0x2556:
      return [
        [0, LC, LCE, L],
        [0.35, LC, L, LCE],
        [0.55, LC, L, LCE],
      ]; // ╖
    case 0x2557:
      return [
        [0, 0.35, LCE, L],
        [0, 0.55, LCE, L],
        [0.35, LC, L, LCE],
        [0.55, LC, L, LCE],
      ]; // ╗

    case 0x2558:
      return [
        [LC, 0.35, LCE, L],
        [LC, 0.55, LCE, L],
        [LC, 0, L, LCE],
      ]; // ╘
    case 0x2559:
      return [
        [0.35, LC, LCE, L],
        [0.35, 0, L, LCE],
        [0.55, 0, L, LCE],
      ]; // ╙
    case 0x255a:
      return [
        [LC, 0.35, LCE, L],
        [LC, 0.55, LCE, L],
        [0.35, 0, L, LCE],
        [0.55, 0, L, LCE],
      ]; // ╚

    case 0x255b:
      return [
        [0, 0.35, LCE, L],
        [0, 0.55, LCE, L],
        [LC, 0, L, LCE],
      ]; // ╛
    case 0x255c:
      return [
        [0, LC, LCE, L],
        [0.35, 0, L, LCE],
        [0.55, 0, L, LCE],
      ]; // ╜
    case 0x255d:
      return [
        [0, 0.35, LCE, L],
        [0, 0.55, LCE, L],
        [0.35, 0, L, LCE],
        [0.55, 0, L, LCE],
      ]; // ╝

    case 0x255e:
      return [
        [LC, 0.35, LCE, L],
        [LC, 0.55, LCE, L],
        [LC, 0, L, 1],
      ]; // ╞
    case 0x255f:
      return [
        [0.35, LC, LCE, L],
        [0.35, 0, L, 1],
        [0.55, 0, L, 1],
      ]; // ╟
    case 0x2560:
      return [
        [LC, 0.35, LCE, L],
        [LC, 0.55, LCE, L],
        [0.35, 0, L, 1],
        [0.55, 0, L, 1],
      ]; // ╠

    case 0x2561:
      return [
        [0, 0.35, LCE, L],
        [0, 0.55, LCE, L],
        [LC, 0, L, 1],
      ]; // ╡
    case 0x2562:
      return [
        [0, LC, LCE, L],
        [0.35, 0, L, 1],
        [0.55, 0, L, 1],
      ]; // ╢
    case 0x2563:
      return [
        [0, 0.35, LCE, L],
        [0, 0.55, LCE, L],
        [0.35, 0, L, 1],
        [0.55, 0, L, 1],
      ]; // ╣

    case 0x2564:
      return [
        [0, 0.35, 1, L],
        [0, 0.55, 1, L],
        [LC, LC, L, LCE],
      ]; // ╤
    case 0x2565:
      return [
        [0, LC, 1, L],
        [0.35, LC, L, LCE],
        [0.55, LC, L, LCE],
      ]; // ╥
    case 0x2566:
      return [
        [0, 0.35, 1, L],
        [0, 0.55, 1, L],
        [0.35, LC, L, LCE],
        [0.55, LC, L, LCE],
      ]; // ╦

    case 0x2567:
      return [
        [0, 0.35, 1, L],
        [0, 0.55, 1, L],
        [LC, 0, L, LCE],
      ]; // ╧
    case 0x2568:
      return [
        [0, LC, 1, L],
        [0.35, 0, L, LCE],
        [0.55, 0, L, LCE],
      ]; // ╨
    case 0x2569:
      return [
        [0, 0.35, 1, L],
        [0, 0.55, 1, L],
        [0.35, 0, L, LCE],
        [0.55, 0, L, LCE],
      ]; // ╩

    case 0x256a:
      return [
        [0, 0.35, 1, L],
        [0, 0.55, 1, L],
        [LC, 0, L, 1],
      ]; // ╪
    case 0x256b:
      return [
        [0, LC, 1, L],
        [0.35, 0, L, 1],
        [0.55, 0, L, 1],
      ]; // ╫
    case 0x256c:
      return [
        [0, 0.35, 1, L],
        [0, 0.55, 1, L],
        [0.35, 0, L, 1],
        [0.55, 0, L, 1],
      ]; // ╬

    // Rounded corners (same geometry as sharp corners)
    case 0x256d:
      return [
        [LC, LC, LCE, L],
        [LC, LC, L, LCE],
      ]; // ╭ rounded down-right
    case 0x256e:
      return [
        [0, LC, LCE, L],
        [LC, LC, L, LCE],
      ]; // ╮ rounded down-left
    case 0x256f:
      return [
        [0, LC, LCE, L],
        [LC, 0, L, LCE],
      ]; // ╯ rounded up-left
    case 0x2570:
      return [
        [LC, LC, LCE, L],
        [LC, 0, L, LCE],
      ]; // ╰ rounded up-right

    // Diagonal lines — fall through to font glyph
    case 0x2571:
      return null; // ╱
    case 0x2572:
      return null; // ╲
    case 0x2573:
      return null; // ╳

    // Half lines
    case 0x2574:
      return [[0, LC, 0.5, L]]; // ╴ light left
    case 0x2575:
      return [[LC, 0, L, 0.5]]; // ╵ light up
    case 0x2576:
      return [[0.5, LC, 0.5, L]]; // ╶ light right
    case 0x2577:
      return [[LC, 0.5, L, 0.5]]; // ╷ light down
    case 0x2578:
      return [[0, HC, 0.5, H]]; // ╸ heavy left
    case 0x2579:
      return [[HC, 0, H, 0.5]]; // ╹ heavy up
    case 0x257a:
      return [[0.5, HC, 0.5, H]]; // ╺ heavy right
    case 0x257b:
      return [[HC, 0.5, H, 0.5]]; // ╻ heavy down

    // Mixed weight lines
    case 0x257c:
      return [
        [0, LC, 0.5, L],
        [0.5, HC, 0.5, H],
      ]; // ╼ light left heavy right
    case 0x257d:
      return [
        [LC, 0, L, 0.5],
        [HC, 0.5, H, 0.5],
      ]; // ╽ light up heavy down
    case 0x257e:
      return [
        [0, HC, 0.5, H],
        [0.5, LC, 0.5, L],
      ]; // ╾ heavy left light right
    case 0x257f:
      return [
        [HC, 0, H, 0.5],
        [LC, 0.5, L, 0.5],
      ]; // ╿ heavy up light down

    default:
      return null;
  }
}

export function getBlockAlpha(cp: number): number {
  if (cp === 0x2591) return 0.25; // ░ light shade
  if (cp === 0x2592) return 0.5; // ▒ medium shade
  if (cp === 0x2593) return 0.75; // ▓ dark shade
  return 1.0;
}
