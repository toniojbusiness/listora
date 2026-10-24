import {
  gtinCheckDigit,
  toGtin,
  type FiberComponent,
  type FiberPart,
  type Gtin,
  type Material,
  type Size,
  type TagValues,
} from '@listora/tag-parse';

import { EDGE_CASES } from './edge-cases.ts';
import { simulateOcr, type GenBlock, type LineRole } from './noise.ts';
import { createRandom, type Random } from './random.ts';
import type { CaseSpec, TagKind } from './types.ts';
import {
  BLENDS,
  BRANDS,
  CALIFORNIA_ADDRESSES,
  CARE_LINES,
  COUNTRY_DISPLAY,
  DISTRACTORS,
  MATERIAL_DISPLAY,
  ORIGIN_POOL,
  OTHER_ADDRESSES,
  OUTERWEAR_PARTS,
} from './vocabulary.ts';

/** Bump when any generator, noise, font, or renderer change alters the committed corpus. */
export const GENERATOR_VERSION = 1;
export const DEFAULT_SEED = 20261024;
export const GENERATED_CASES = 220;

/**
 * Builds the whole corpus spec: seeded generated cases followed by the hand-written edge cases.
 * Facts are drawn first, then printed; the ground truth is the drawn facts, never a re-parse of
 * the printed text.
 */
export function buildCorpusSpecs(seed = DEFAULT_SEED, count = GENERATED_CASES): CaseSpec[] {
  const random = createRandom(seed);
  const generated = Array.from({ length: count }, (_, index) => generateCase(random, index + 1));
  return [...generated, ...EDGE_CASES];
}

const KIND_WEIGHTS: readonly (readonly [Exclude<TagKind, 'edge_case'>, number])[] = [
  ['care_label', 40],
  ['hang_tag', 20],
  ['neck_label', 15],
  ['denim_label', 10],
  ['shoe_label', 15],
];

function generateCase(random: Random, number: number): CaseSpec {
  const kind = weighted(random, KIND_WEIGHTS);
  const tag = new TagBuilder(random, random.chance(0.3) ? 'title' : 'upper');
  switch (kind) {
    case 'care_label':
      careLabel(tag);
      break;
    case 'hang_tag':
      hangTag(tag);
      break;
    case 'neck_label':
      neckLabel(tag);
      break;
    case 'denim_label':
      denimLabel(tag);
      break;
    case 'shoe_label':
      shoeLabel(tag);
      break;
  }
  const id = `${kind.replace('_', '-')}-${String(number).padStart(3, '0')}`;
  return {
    id,
    kind,
    printed: tag.printed(),
    ocr: simulateOcr(tag.blocks, random),
    truth: tag.truth(),
  };
}

// ---------------------------------------------------------------------------------------------
// Tag layouts

function careLabel(tag: TagBuilder): void {
  if (tag.random.chance(0.5)) tag.brand();
  if (tag.random.chance(0.6))
    tag.size(tag.random.pick(['letter', 'letter', 'numeric', 'multi', 'spelled'] as const));
  if (tag.random.chance(0.2)) tag.outerwear();
  else tag.fibers();
  tag.origin();
  const registration = tag.random.next();
  if (registration < 0.45) tag.rn();
  else if (registration < 0.6) tag.rnAndCa();
  else if (tag.random.chance(0.5)) tag.ca();
  if (tag.random.chance(0.15)) tag.style();
  tag.care(tag.random.int(1, 4));
  if (tag.random.chance(0.35)) tag.distractor();
}

function hangTag(tag: TagBuilder): void {
  tag.brand();
  if (tag.random.chance(0.8)) tag.style();
  tag.size(tag.random.pick(['letter', 'letter', 'numeric', 'multi', 'one_size'] as const));
  tag.line(tag.price(), 'price');
  if (tag.random.chance(0.3)) tag.fibers();
  tag.barcode(tag.random.chance(0.9));
  if (tag.random.chance(0.3)) tag.distractor();
}

function neckLabel(tag: TagBuilder): void {
  tag.brand();
  tag.size(tag.random.pick(['letter', 'letter', 'letter', 'bare', 'one_size', 'spelled'] as const));
  if (tag.random.chance(0.8)) tag.origin();
  if (tag.random.chance(0.3)) tag.rn();
}

function denimLabel(tag: TagBuilder): void {
  tag.brand('STONE RIVER DENIM');
  tag.waistInseam();
  if (tag.random.chance(0.6)) tag.style();
  tag.fibers(tag.random.pick(BLENDS.filter((blend) => blend[0]?.[0] === 'cotton')));
  tag.origin();
  if (tag.random.chance(0.6)) tag.rn();
  if (tag.random.chance(0.3)) tag.care(1);
}

function shoeLabel(tag: TagBuilder): void {
  if (tag.random.chance(0.6)) tag.brand('PARALLEL ATHLETIC');
  tag.shoeSizes();
  if (tag.random.chance(0.8)) tag.style();
  tag.origin();
  if (tag.random.chance(0.7)) tag.barcode(true);
}

// ---------------------------------------------------------------------------------------------
// Builder

type CaseStyle = 'upper' | 'title';
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K] };

class TagBuilder {
  readonly random: Random;
  readonly blocks: GenBlock[] = [];
  readonly #style: CaseStyle;
  readonly #truth: Mutable<TagValues> = {
    rn: [],
    ca: [],
    gtin: [],
    size: [],
    fiber: [],
    origin: [],
    style: [],
  };

  constructor(random: Random, style: CaseStyle) {
    this.random = random;
    this.#style = style;
  }

  truth(): TagValues {
    return structuredClone(this.#truth);
  }

  printed(): CaseSpec['printed'] {
    return this.blocks.map((block) =>
      block.kind === 'barcode' ? { barcode: block.digits } : { text: block.text },
    );
  }

  line(text: string, role: LineRole): void {
    this.blocks.push({ kind: 'line', text, role });
  }

  /** Applies the tag's case style: title case keeps codes such as USA, RN, and XL in capitals. */
  cased(text: string): string {
    if (this.#style === 'upper') return text;
    const titled = text.replace(/\b[A-Z]{2,}\b/g, (word) => {
      if (KEEP_UPPER.has(word)) return word;
      if (SMALL_WORDS.has(word)) return word.toLowerCase();
      return `${word.slice(0, 1)}${word.slice(1).toLowerCase()}`;
    });
    return `${titled.slice(0, 1).toUpperCase()}${titled.slice(1)}`;
  }

  brand(name?: string): void {
    this.line(this.cased(name ?? this.random.pick(BRANDS)), 'brand');
  }

  rn(): void {
    const number = String(this.random.int(13670, 169999));
    this.#truth.rn.push(number);
    this.line(
      this.random
        .pick(['RN {n}', 'RN# {n}', 'RN #{n}', 'RN#{n}', 'RN: {n}', 'R.N. {n}', 'RN NO. {n}'])
        .replace('{n}', number),
      'rn',
    );
  }

  ca(): void {
    const number = String(this.random.int(10000, 99999));
    this.#truth.ca.push(number);
    this.line(
      this.random
        .pick(['CA {n}', 'CA# {n}', 'CA#{n}', 'CA: {n}', 'CA NO. {n}'])
        .replace('{n}', number),
      'ca',
    );
  }

  rnAndCa(): void {
    const rn = String(this.random.int(13670, 169999));
    const ca = String(this.random.int(10000, 99999));
    this.#truth.rn.push(rn);
    this.#truth.ca.push(ca);
    this.line(
      this.random
        .pick(['RN {rn} CA {ca}', 'RN#{rn}  CA#{ca}', 'RN {rn} / CA {ca}'])
        .replace('{rn}', rn)
        .replace('{ca}', ca),
      'rnca',
    );
  }

  style(): void {
    const value = styleNumber(this.random);
    this.#truth.style.push(value);
    const label = this.random.pick([
      'STYLE # ',
      'STYLE NO. ',
      'STYLE: ',
      'STYLE ',
      'ART. NO. ',
      'ITEM # ',
      'MODEL: ',
      'PROD. NO. ',
      'REF. ',
    ]);
    this.line(`${label}${value}`, 'style');
  }

  origin(): void {
    const code = this.random.pick(ORIGIN_POOL);
    const display = COUNTRY_DISPLAY[code];
    if (display === undefined) throw new Error(`no display name for ${code}`);
    this.#truth.origin.push(code);
    const name = this.random.pick(display.names);
    const variant = this.random.next();
    if (variant < 0.15 && display.fr !== undefined && display.es !== undefined) {
      const english = name === 'THE USA' ? 'USA' : name;
      this.line(
        `MADE IN ${english} / FABRIQUE EN ${display.fr} / HECHO EN ${display.es}`,
        'origin',
      );
    } else if (variant < 0.25 && display.es !== undefined) {
      this.line(this.cased(`MADE IN ${name}`), 'origin');
      this.line(this.cased(`HECHO EN ${display.es}`), 'origin');
    } else if (variant < 0.3) {
      this.line(this.cased(`PRODUCT OF ${name}`), 'origin');
    } else {
      this.line(this.cased(`MADE IN ${name}`), 'origin');
    }
  }

  size(format: 'letter' | 'numeric' | 'multi' | 'spelled' | 'one_size' | 'bare'): void {
    const random = this.random;
    switch (format) {
      case 'letter': {
        const letter = random.pick(['XS', 'S', 'M', 'L', 'XL', 'XXL', 'S', 'M', 'L']);
        this.#addSize({ system: 'letter', value: letter });
        const companion = MEXICAN_SIZES[letter];
        const template = random.pick([
          'SIZE {s}',
          'SIZE: {s}',
          'SIZE {s}',
          '{s}',
          companion === undefined ? '{s}' : `{s}/${companion}`,
          RANGES[letter] === undefined ? 'SIZE {s}' : `{s} (${RANGES[letter]})`,
          'TALLA/SIZE/TAILLE: {s}',
        ]);
        this.line(
          template.replace('{s}', letter),
          template.startsWith('{s}') ? 'size_bare' : 'size_labeled',
        );
        return;
      }
      case 'spelled': {
        const [word, value] = random.pick([
          ['SMALL', 'S'],
          ['MEDIUM', 'M'],
          ['LARGE', 'L'],
          ['X-LARGE', 'XL'],
          ['EXTRA LARGE', 'XL'],
          ['XX-LARGE', 'XXL'],
          ['X-SMALL', 'XS'],
        ] as const);
        this.#addSize({ system: 'letter', value });
        this.line(this.cased(`SIZE ${word}`), 'size_labeled');
        return;
      }
      case 'numeric': {
        const value = String(random.pick([0, 2, 4, 6, 8, 10, 12, 14, 16]));
        this.#addSize({ system: 'numeric', value });
        this.line(
          random.pick(['SIZE {n}', 'SIZE: {n}', 'TALLA {n}']).replace('{n}', value),
          'size_labeled',
        );
        return;
      }
      case 'bare': {
        const value = String(random.pick([0, 2, 4, 6, 8, 10, 12, 14]));
        this.#addSize({ system: 'numeric', value });
        this.line(value, 'size_bare');
        return;
      }
      case 'multi': {
        const us = random.pick([0, 2, 4, 6, 8, 10, 12, 14]);
        this.#addSize({ system: 'us', value: String(us) });
        this.#addSize({ system: 'uk', value: String(us + 4) });
        this.#addSize({ system: 'eu', value: String(us + 32) });
        const template = random.pick([
          'US {us} / UK {uk} / EU {eu}',
          'US {us} UK {uk} EUR {eu}',
          'US {us}  UK {uk}  EU {eu}',
        ]);
        this.line(
          template
            .replace('{us}', String(us))
            .replace('{uk}', String(us + 4))
            .replace('{eu}', String(us + 32)),
          'size_labeled',
        );
        return;
      }
      case 'one_size': {
        this.#addSize({ system: 'one_size', value: 'OS' });
        this.line(
          random.pick(['ONE SIZE', 'O/S', 'ONE SIZE FITS MOST', 'SIZE: OS']),
          'size_labeled',
        );
        return;
      }
    }
  }

  waistInseam(): void {
    const waist = this.random.pick([26, 28, 29, 30, 31, 32, 33, 34, 36, 38, 40]);
    const inseam = this.random.pick([28, 30, 32, 34]);
    this.#addSize({ system: 'waist_inseam', value: `${String(waist)}x${String(inseam)}` });
    const template = this.random.pick([
      'W{w} L{l}',
      '{w}W {l}L',
      '{w}X{l}',
      '{w} x {l}',
      'W{w}/L{l}',
      'SIZE: {w}X{l}',
      'WAIST {w} INSEAM {l}',
    ]);
    this.line(
      template.replace('{w}', String(waist)).replace('{l}', String(inseam)),
      template.includes('SIZE') || template.startsWith('W') ? 'size_labeled' : 'size_bare',
    );
  }

  shoeSizes(): void {
    const us = this.random.int(10, 26) / 2;
    const uk = us - 1;
    const eu = this.random.pick([Math.round(us + 33), us + 33.5]);
    this.#addSize({ system: 'us', value: String(us) });
    this.#addSize({ system: 'uk', value: String(uk) });
    this.#addSize({ system: 'eu', value: String(eu) });
    const template = this.random.pick([
      'US {us} UK {uk} EUR {eu}',
      'US {us} / UK {uk} / EU {eu}',
      'US: {us}  UK: {uk}  EUR: {eu}',
    ]);
    this.line(
      template.replace('{us}', String(us)).replace('{uk}', String(uk)).replace('{eu}', String(eu)),
      'size_labeled',
    );
  }

  fibers(blend = this.random.pick(BLENDS)): void {
    const components = blend.map(([material, percent]): FiberComponent => ({
      part: null,
      material,
      percent,
    }));
    this.#truth.fiber.push(...components);
    const layout = this.random.next();
    if (layout < 0.15) {
      // One line per language.
      this.line(this.#composition(components, 'en', 'percent-first'), 'fiber');
      this.line(this.#composition(components, 'fr', 'percent-first'), 'fiber');
      this.line(this.#composition(components, 'es', 'percent-first'), 'fiber');
    } else if (layout < 0.25) {
      // Each component followed by its translations.
      for (const component of components) {
        const display = MATERIAL_DISPLAY[component.material];
        this.line(
          `${String(component.percent)}% ${this.#english(component.material)} / ${display.fr} / ${display.es}`,
          'fiber',
        );
      }
    } else if (layout < 0.4 && components.length > 1) {
      for (const component of components)
        this.line(this.cased(this.#composition([component], 'en', 'percent-first')), 'fiber');
    } else if (layout < 0.5) {
      this.line(this.cased(this.#composition(components, 'en', 'material-first')), 'fiber');
    } else if (layout < 0.58 && components.length === 1) {
      this.line(
        this.cased(`${this.#composition(components, 'en', 'percent-first')} EXCLUSIVE OF TRIM`),
        'fiber',
      );
    } else {
      this.line(this.cased(this.#composition(components, 'en', 'percent-first')), 'fiber');
    }
  }

  outerwear(): void {
    const parts = this.random.pick(OUTERWEAR_PARTS);
    const headerLayout = this.random.chance(0.3);
    for (const [part, blend] of Object.entries(parts) as [
      FiberPart,
      readonly (readonly [Material, number])[],
    ][]) {
      const components = blend.map(([material, percent]): FiberComponent => ({
        part,
        material,
        percent,
      }));
      this.#truth.fiber.push(...components);
      const label = PART_LABELS[part];
      const composition = this.#composition(components, 'en', 'percent-first');
      if (headerLayout) {
        this.line(this.cased(label), 'fiber_header');
        this.line(this.cased(composition), 'fiber');
      } else {
        this.line(this.cased(`${label}: ${composition}`), 'fiber');
      }
    }
  }

  care(count: number): void {
    for (const line of this.random.sample(CARE_LINES, count)) this.line(this.cased(line), 'care');
  }

  distractor(): void {
    const choice = this.random.next();
    if (choice < 0.35) {
      const [city, prefix] = this.random.pick(CALIFORNIA_ADDRESSES);
      const zip = `${prefix}${this.random.digits(2)}`;
      this.line(
        this.random.chance(0.3) ? `${city}, CA ${zip} USA` : `${city}, CA ${zip}`,
        'distractor',
      );
    } else if (choice < 0.45) {
      this.line(this.random.pick(OTHER_ADDRESSES), 'distractor');
    } else {
      this.line(this.cased(this.random.pick(DISTRACTORS)), 'distractor');
    }
  }

  price(): string {
    const dollars = this.random.pick([18, 24, 28, 34, 39, 48, 58, 65, 79, 98, 128]);
    return this.random
      .pick(['$<d>.00', 'MSRP $<d>.00', '$<d>.99', 'PRICE $<d>'])
      .replace('<d>', String(dollars));
  }

  /** A UPC-A or EAN-13 barcode block. Invalid codes carry a wrong check digit and no truth. */
  barcode(valid: boolean): void {
    const body = this.random.chance(0.7)
      ? `${this.random.pick(['0', '0', '1', '6', '7', '8'])}${this.random.digits(10)}`
      : `${this.random.pick(['40', '50', '57', '76', '80', '84', '87', '89', '93'])}${this.random.digits(10)}`;
    const check = gtinCheckDigit(body);
    const digits = `${body}${String(valid ? check : (check + this.random.int(1, 9)) % 10)}`;
    if (valid) {
      const gtin: Gtin | null = toGtin(digits);
      if (gtin === null) throw new Error('generated an invalid GTIN');
      this.#truth.gtin.push(gtin);
    }
    this.blocks.push({ kind: 'barcode', digits, valid });
  }

  #addSize(size: Size): void {
    this.#truth.size.push(size);
  }

  #english(material: Material): string {
    return this.random.pick(MATERIAL_DISPLAY[material].en);
  }

  #composition(
    components: readonly FiberComponent[],
    language: 'en' | 'fr' | 'es',
    order: 'percent-first' | 'material-first',
  ): string {
    const separator = this.random.pick([' ', ' / ', ', ']);
    return components
      .map(({ material, percent }) => {
        const name =
          language === 'en' ? this.#english(material) : MATERIAL_DISPLAY[material][language];
        return order === 'percent-first'
          ? `${String(percent)}% ${name}`
          : `${name} ${String(percent)}%`;
      })
      .join(separator);
  }
}

const KEEP_UPPER = new Set([
  'USA',
  'UK',
  'EU',
  'EUR',
  'US',
  'RN',
  'CA',
  'OS',
  'XS',
  'XL',
  'XXL',
  'NO',
  'CH',
  'EG',
]);
const SMALL_WORDS = new Set(['IN', 'EN', 'OF', 'THE', 'DE', 'AU']);
const MEXICAN_SIZES: Readonly<Record<string, string>> = {
  S: 'P/CH',
  M: 'M/M',
  L: 'G/G',
  XL: 'EG/EG',
};
const RANGES: Readonly<Record<string, string>> = {
  XS: '0-2',
  S: '4-6',
  M: '8-10',
  L: '12-14',
  XL: '16',
};
const PART_LABELS: Readonly<Record<FiberPart, string>> = {
  shell: 'SHELL',
  body: 'BODY',
  lining: 'LINING',
  trim: 'TRIM',
  fill: 'FILL',
  contrast: 'CONTRAST',
  pocketing: 'POCKETING',
  rib: 'RIB',
};

function styleNumber(random: Random): string {
  const letters = (n: number): string =>
    Array.from({ length: n }, () => String.fromCharCode(65 + random.int(0, 25))).join('');
  switch (random.int(0, 4)) {
    case 0:
      return random.digits(6).replace(/^0/, '4');
    case 1:
      return `${letters(2)}${random.digits(4)}`;
    case 2:
      return `${letters(2)}${random.digits(4)}-${random.digits(3)}`;
    case 3:
      return `${String(random.int(1000, 9999))}-${random.digits(2)}`;
    default:
      return `${letters(1)}-${String(random.int(10000, 99999))}`;
  }
}

function weighted<T>(random: Random, weights: readonly (readonly [T, number])[]): T {
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random.next() * total;
  for (const [value, weight] of weights) {
    roll -= weight;
    if (roll < 0) return value;
  }
  const last = weights.at(-1);
  if (last === undefined) throw new RangeError('no weights');
  return last[0];
}
