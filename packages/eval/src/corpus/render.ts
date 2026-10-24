import { EAN13_MODULES, ean13Modules, humanReadable } from './barcode.ts';
import { GLYPH_HEIGHT, GLYPH_WIDTH, glyph } from './font.ts';
import type { Raster } from './png.ts';
import type { PrintedBlock, TagKind } from './types.ts';

/** Layout constants, in output pixels. */
const SCALE = 3;
const LINE_GAP = 3 * SCALE;
const MARGIN = 36;
const MIN_WIDTH = 360;
const MODULE = 3;
const QUIET_ZONE_MODULES = 11;
const BAR_HEIGHT = 96;
const BARCODE_TEXT_GAP = 12;
const BLOCK_GAP = 12;

const PAPER = 250;
const INK = 28;
const EDGE = 196;
const HOLE_RADIUS = 11;

/** Renders printed blocks as a centered, bordered tag. Pure: the same blocks give the same pixels. */
export function renderTag(blocks: readonly PrintedBlock[], kind: TagKind): Raster {
  const barcodeWidth = (EAN13_MODULES + 2 * QUIET_ZONE_MODULES) * MODULE;
  const contentWidth = Math.max(
    0,
    ...blocks.map((block) =>
      'text' in block
        ? textWidth(block.text, SCALE)
        : Math.max(barcodeWidth, textWidth(humanReadable(block.barcode), SCALE)),
    ),
  );
  const width = Math.max(MIN_WIDTH, contentWidth + 2 * MARGIN);
  const top = kind === 'hang_tag' ? MARGIN + 3 * HOLE_RADIUS : MARGIN;
  const height =
    top + MARGIN + blocks.reduce((sum, block) => sum + blockHeight(block), 0) - LINE_GAP;
  const canvas = new Canvas(width, height);

  canvas.frame(6, 2, EDGE);
  if (kind === 'hang_tag') canvas.ring(Math.floor(width / 2), MARGIN, HOLE_RADIUS, 3, EDGE);

  let y = top;
  for (const block of blocks) {
    if ('text' in block) {
      canvas.text(block.text, centered(width, textWidth(block.text, SCALE)), y, SCALE);
    } else {
      const modules = ean13Modules(block.barcode);
      const left = centered(width, EAN13_MODULES * MODULE);
      for (let i = 0; i < modules.length; i += 1) {
        if (modules[i] === '1') canvas.fill(left + i * MODULE, y, MODULE, BAR_HEIGHT, INK);
      }
      const digits = humanReadable(block.barcode);
      canvas.text(
        digits,
        centered(width, textWidth(digits, SCALE)),
        y + BAR_HEIGHT + BARCODE_TEXT_GAP,
        SCALE,
      );
    }
    y += blockHeight(block);
  }
  return canvas.raster();
}

function blockHeight(block: PrintedBlock): number {
  if ('text' in block) return GLYPH_HEIGHT * SCALE + LINE_GAP;
  return BAR_HEIGHT + BARCODE_TEXT_GAP + GLYPH_HEIGHT * SCALE + BLOCK_GAP + LINE_GAP;
}

function textWidth(text: string, scale: number): number {
  return text.length === 0 ? 0 : text.length * (GLYPH_WIDTH + 1) * scale - scale;
}

function centered(width: number, inner: number): number {
  return Math.floor((width - inner) / 2);
}

class Canvas {
  readonly #width: number;
  readonly #height: number;
  readonly #pixels: Uint8Array;

  constructor(width: number, height: number) {
    this.#width = width;
    this.#height = height;
    this.#pixels = new Uint8Array(width * height).fill(PAPER);
  }

  fill(x: number, y: number, w: number, h: number, value: number): void {
    for (let row = Math.max(0, y); row < Math.min(this.#height, y + h); row += 1) {
      const start = row * this.#width;
      this.#pixels.fill(value, start + Math.max(0, x), start + Math.min(this.#width, x + w));
    }
  }

  /** A rectangle outline `inset` pixels inside the edge, `thickness` pixels wide. */
  frame(inset: number, thickness: number, value: number): void {
    const w = this.#width - 2 * inset;
    const h = this.#height - 2 * inset;
    this.fill(inset, inset, w, thickness, value);
    this.fill(inset, inset + h - thickness, w, thickness, value);
    this.fill(inset, inset, thickness, h, value);
    this.fill(inset + w - thickness, inset, thickness, h, value);
  }

  /** A punched-hole ring centered at (cx, cy). */
  ring(cx: number, cy: number, radius: number, thickness: number, value: number): void {
    for (let y = cy - radius; y <= cy + radius; y += 1) {
      for (let x = cx - radius; x <= cx + radius; x += 1) {
        const distance = Math.hypot(x - cx, y - cy);
        if (distance <= radius && distance > radius - thickness) this.fill(x, y, 1, 1, value);
      }
    }
  }

  text(text: string, x: number, y: number, scale: number): void {
    const advance = (GLYPH_WIDTH + 1) * scale;
    Array.from(text).forEach((char, index) => {
      glyph(char).forEach((row, rowIndex) => {
        row.forEach((ink, column) => {
          if (!ink) return;
          this.fill(x + index * advance + column * scale, y + rowIndex * scale, scale, scale, INK);
        });
      });
    });
  }

  raster(): Raster {
    return { width: this.#width, height: this.#height, pixels: this.#pixels };
  }
}
