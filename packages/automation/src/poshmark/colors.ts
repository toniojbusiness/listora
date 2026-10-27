/**
 * Poshmark's colors for an item's canonical colors (`ItemSnapshot.colors`). Poshmark's form offers
 * 15 colors (catalog.json) and takes up to two. A color Poshmark lacks maps to its nearest one
 * (beige to Tan, navy to Blue); multicolor has none, so it is left out.
 */
import { POSHMARK_COLORS } from './catalog.ts';

/** How many colors a Poshmark listing takes. */
export const MAX_POSHMARK_COLORS = 2;

const NEAREST: Readonly<Record<string, string>> = {
  beige: 'Tan',
  navy: 'Blue',
};

/** The item's colors as Poshmark names them, in the item's order, at most two. */
export function poshmarkColors(colors: readonly string[]): string[] {
  const named = colors.flatMap((color) => {
    const id = color.trim().toLowerCase();
    const name =
      NEAREST[id] ?? POSHMARK_COLORS.find((offered) => offered.toLowerCase() === id) ?? null;
    return name === null ? [] : [name];
  });
  return [...new Set(named)].slice(0, MAX_POSHMARK_COLORS);
}
