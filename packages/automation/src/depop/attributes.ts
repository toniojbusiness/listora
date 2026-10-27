/**
 * The sell form's item details besides the category, size, brand, and condition, each from Depop's
 * own lists (taxonomy/taxonomy.json), and only where the product type offers it:
 *
 * - the colours (Depop takes up to 2) and the material (up to 4), from the item's own canonical
 *   colours and materials; a colour or material Depop has no value for is left out;
 * - the body fit (Petite, Plus size, Tall, Maternity), from the size label (`4P`, `16W`, `XL
 *   Tall`) or the listing's own name ("Petite", "Plus size", "Maternity");
 * - a dress's or skirt's length (Maxi, Midi, Mini), a dress's type (A-line, Bodycon, Slip, ...),
 *   and a bottom's fit (Skinny, High waisted, Wide leg, ...) and type (Distressed, Cargo, ...),
 *   from the words of the listing's own name (its title and the item's product name), never
 *   guessed from the photos;
 * - the style (up to 3), from the listing's hashtags that are one of Depop's styles (`#y2k` is
 *   Y2K, `#boho` Boho).
 *
 * Depop's occasion, source, and age are left as the seller sets them on Depop.
 */
import type { ItemSnapshot, ListingVariant } from '@listora/marketplaces';

import { readAdultSize } from '../adapter/adult-size.ts';
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

/**
 * Words of a listing's name to Depop's values of an item specific, by the value's name; the
 * first that names one wins where the form takes one value. Only values the live form offers
 * (read on the captain's session, 2026-10-27: its Fit list has no "tapered" or "relaxed").
 */
const NAME_WORDS: Readonly<Record<string, readonly (readonly [RegExp, string])[]>> = {
  'dress-length': [
    [/\bmaxi\b/, 'Maxi'],
    [/\bmidi\b/, 'Midi'],
    [/\bmini\b/, 'Mini'],
  ],
  'dress-type': [
    [/\ba[\s-]?line\b/, 'A-line'],
    [/\bbaby[\s-]?doll\b/, 'Babydoll'],
    [/\bblazer\b/, 'Blazer'],
    [/\bbodycon\b/, 'Bodycon'],
    [/\b(?:fishtail|mermaid)\b/, 'Fishtail'],
    [/\bpencil\b/, 'Pencil'],
    [/\bpleat(?:ed|s)?\b/, 'Pleated'],
    [/\bshirt[\s-]?dress\b/, 'Shirt'],
    [/\bslip\b(?![\s-]?ons?\b)/, 'Slip'],
  ],
  'bottom-style': [
    [/\bboot[\s-]?cut\b/, 'Bootcut'],
    [/\bflare[ds]?\b/, 'Flare'],
    [/\bhigh[\s-]?(?:waist(?:ed)?|rise)\b/, 'High waisted'],
    [/\blow[\s-]?(?:rise|waist(?:ed)?)\b/, 'Low rise'],
    [/\bskinny\b/, 'Skinny'],
    [/\bslim\b/, 'Slim'],
    [/\bstraight\b/, 'Straight leg'],
    [/\btailored\b/, 'Tailored'],
    [/\bwide[\s-]?leg\b/, 'Wide leg'],
  ],
  'bottom-fit': [
    [/\bacid[\s-]?wash(?:ed)?\b/, 'Acid-washed'],
    [/\bbleach(?:ed)?\b/, 'Bleached'],
    [/\bcapris?\b/, 'Capri'],
    [/\bcargos?\b/, 'Cargo'],
    [/\bchinos?\b/, 'Chino'],
    [/\bdistressed\b/, 'Distressed'],
    [/\bembroidered\b/, 'Embroidered'],
    [/\bfaded\b/, 'Faded'],
    [/\b(?:ripped|destroyed)\b/, 'Ripped'],
    [/\bstone[\s-]?wash(?:ed)?\b/, 'Stone-washed'],
  ],
  'body-fit': [
    [/\bpetite\b/, 'Petite'],
    [/\bplus[\s-]size\b/, 'Plus size'],
    [/\bmaternity\b/, 'Maternity'],
  ],
};

/** The size label's fit, as Depop's body fit names it. */
const FITS = { petite: 'Petite', plus: 'Plus size', tall: 'Tall' } as const;

/** The item details to pick for an item whose product type offers `attributes`. */
export function depopDetails(
  item: ItemSnapshot,
  variant: Pick<ListingVariant, 'title' | 'hashtags'>,
  attributes: readonly string[],
): DepopFormPick[] {
  const picks: DepopFormPick[] = [];
  const add = (field: string, values: readonly string[]) => {
    if (values.length > 0) picks.push({ field, values: [...values] });
  };
  add('colour', labels('colour', item.colors, DEPOP_COLOURS));
  if (attributes.includes('material')) {
    add('attributes.material', labels('material', item.materials, DEPOP_MATERIALS));
  }
  const name = [variant.title, item.productName ?? ''].join(' ').toLowerCase();
  for (const attribute of [
    'dress-length',
    'dress-type',
    'bottom-style',
    'bottom-fit',
    'body-fit',
  ]) {
    if (!attributes.includes(attribute)) continue;
    const named = (NAME_WORDS[attribute] ?? []).flatMap(([pattern, value]) =>
      pattern.test(name) ? [value] : [],
    );
    const fit = attribute === 'body-fit' ? readAdultSize(item.sizeLabel)?.fit : undefined;
    add(`attributes.${attribute}`, offered(attribute, [...(fit ? [FITS[fit]] : []), ...named]));
  }
  add('style', offered('style', variant.hashtags.map(styleOf)));
  return picks;
}

/** A hashtag as the style it may name: `y2k` is `Y2K`, `streetwear` `Streetwear`. */
function styleOf(hashtag: string): string {
  const own = hashtag.toLowerCase().replace(/[^a-z0-9]/g, '');
  const style = depopAttribute('style')?.values.find(
    (value) => value.name.toLowerCase().replace(/[^a-z0-9]/g, '') === own,
  );
  return style?.name ?? '';
}

/** The values Depop's list of the attribute has, once each, in order, at most the form's limit. */
function offered(attribute: string, values: readonly string[]): string[] {
  const data = depopAttribute(attribute);
  if (data === null) return [];
  const names = new Set(data.values.map((value) => value.name));
  return [...new Set(values.filter((value) => names.has(value)))].slice(0, data.max);
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
