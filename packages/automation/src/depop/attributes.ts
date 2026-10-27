/**
 * The sell form's item details besides the category, size, brand, and condition: the colours
 * (Depop takes up to 2) and, for product types that offer it, the material (up to 4), from the
 * item's own canonical colours and materials. Values come from Depop's own lists
 * (taxonomy/taxonomy.json); a colour or material Depop has no value for is left out. Depop's
 * other optional details (style, age, source, occasion, fit, and each category's type) are
 * left as the seller sets them on Depop.
 */
import type { ItemSnapshot } from '@listora/marketplaces';

import { depopAttribute } from './taxonomy/taxonomy.ts';

/** Listora's colours (packages/analysis vocabulary.ts) to Depop's colour ids. */
export const DEPOP_COLOURS: Readonly<Record<string, string>> = {
  black: 'black',
  white: 'white',
  gray: 'grey',
  cream: 'cream',
  beige: 'tan',
  tan: 'tan',
  brown: 'brown',
  red: 'red',
  pink: 'pink',
  orange: 'orange',
  yellow: 'yellow',
  green: 'green',
  blue: 'blue',
  navy: 'navy',
  purple: 'purple',
  gold: 'gold',
  silver: 'silver',
  multicolor: 'multi',
};

/** Listora's materials (packages/analysis vocabulary.ts) to Depop's material ids. */
export const DEPOP_MATERIALS: Readonly<Record<string, string>> = {
  acrylic: 'acrylic',
  canvas: 'canvas',
  cashmere: 'cashmere',
  cotton: 'cotton',
  denim: 'denim',
  faux_fur: 'faux-fur',
  faux_leather: 'faux-leather',
  fleece: 'fleece',
  hemp: 'hemp',
  leather: 'leather',
  linen: 'linen',
  lyocell: 'lyocell',
  merino_wool: 'wool',
  modal: 'modal',
  nylon: 'nylon',
  polyester: 'polyester',
  rayon: 'rayon',
  rubber: 'rubber',
  silk: 'silk',
  spandex: 'elastane-lycra-spandex',
  suede: 'suede',
  viscose: 'viscose',
  wool: 'wool',
};

/** One of the form's pickers and the values to pick in it, by their labels. */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type DepopFormPick = { field: string; values: string[] };

/** The colours and materials to pick for an item whose product type offers `attributes`. */
export function depopDetails(item: ItemSnapshot, attributes: readonly string[]): DepopFormPick[] {
  const picks: DepopFormPick[] = [];
  const colours = labels('colour', item.colors, DEPOP_COLOURS);
  if (colours.length > 0) picks.push({ field: 'colour', values: colours });
  if (attributes.includes('material')) {
    const materials = labels('material', item.materials, DEPOP_MATERIALS);
    if (materials.length > 0) picks.push({ field: 'attributes.material', values: materials });
  }
  return picks;
}

/** The labels of Depop's values for the item's own, in order, at most the form's limit. */
function labels(
  attribute: string,
  own: readonly string[],
  ids: Readonly<Record<string, string>>,
): string[] {
  const data = depopAttribute(attribute);
  if (data === null) return [];
  const names = own.flatMap((value) => {
    const id = ids[value];
    const name = data.values.find((entry) => entry.id === id)?.name;
    return name === undefined ? [] : [name];
  });
  return [...new Set(names)].slice(0, data.max);
}
