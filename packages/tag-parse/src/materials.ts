/**
 * Fiber names keyed by the canonical material Listora stores. Spellings are normalized
 * (uppercase ASCII) and cover the English, Spanish, French, Italian, and German forms printed on
 * multilingual care labels. Multi-word spellings are matched before single words.
 */
export const MATERIAL_NAMES = {
  acetate: ['ACETATE', 'ACETATO', 'AZETAT'],
  acrylic: ['ACRYLIC', 'ACRILICO', 'ACRYLIQUE', 'ACRYL'],
  alpaca: ['ALPACA', 'ALPAGA', 'ALPAKA'],
  angora: ['ANGORA'],
  cashmere: ['CASHMERE', 'CACHEMIRE', 'CACHEMIRA', 'KASCHMIR'],
  cotton: ['COTTON', 'ALGODON', 'COTON', 'COTONE', 'BAUMWOLLE'],
  hemp: ['HEMP', 'CANAMO', 'CHANVRE', 'CANAPA', 'HANF'],
  leather: ['LEATHER', 'CUERO', 'CUIR', 'PELLE', 'LEDER'],
  linen: ['LINEN', 'FLAX', 'LINO', 'LIN', 'LEINEN'],
  lyocell: ['LYOCELL', 'TENCEL'],
  merino_wool: ['MERINO WOOL', 'LANA MERINO', 'LAINE MERINOS', 'MERINO'],
  metallic: ['METALLIC FIBER', 'METALLIC FIBERS', 'METALLIC', 'METALIZADA', 'METALLISEE'],
  modal: ['MODAL'],
  mohair: ['MOHAIR'],
  nylon: ['NYLON', 'NAILON', 'POLYAMIDE', 'POLIAMIDA', 'POLIAMMIDE', 'POLYAMID'],
  other: [
    'OTHER FIBERS',
    'OTHER FIBRES',
    'OTHER FIBER',
    'OTRAS FIBRAS',
    'AUTRES FIBRES',
    'ALTRE FIBRE',
    'SONSTIGE FASERN',
  ],
  polyester: ['POLYESTER', 'POLIESTER', 'POLIESTERE'],
  polyurethane: ['POLYURETHANE', 'POLIURETANO', 'POLYURETHANNE', 'POLYURETHAN'],
  rayon: ['RAYON', 'RAYONNE'],
  silk: ['SILK', 'SEDA', 'SOIE', 'SETA', 'SEIDE'],
  spandex: ['SPANDEX', 'ELASTANE', 'ELASTANO', 'ELASTHANNE', 'ELASTAN', 'LYCRA'],
  viscose: ['VISCOSE', 'VISCOSA', 'VISKOSE'],
  wool: ['WOOL', 'LANA', 'LAINE', 'WOLLE'],
} as const satisfies Record<string, readonly string[]>;

export type Material = keyof typeof MATERIAL_NAMES;

/** Garment-part labels such as "SHELL:" or "LINING 100% POLYESTER", with their translations. */
export const FIBER_PART_NAMES = {
  shell: ['OUTER SHELL', 'SHELL', 'OUTER', 'EXTERIOR', 'TISSU', 'TEJIDO'],
  body: ['BODY', 'MAIN', 'CUERPO', 'CORPS'],
  lining: ['LINING', 'LINER', 'FORRO', 'DOUBLURE', 'FODERA', 'FUTTER'],
  trim: ['TRIM', 'ADORNO', 'GARNITURE'],
  fill: ['FILLING', 'FILL', 'PADDING', 'RELLENO', 'REMBOURRAGE'],
  contrast: ['CONTRAST', 'CONTRASTE'],
  pocketing: ['POCKETING', 'POCKET', 'BOLSILLO', 'POCHE'],
  rib: ['RIBBING', 'RIB', 'PUNO', 'BORD-COTE'],
} as const satisfies Record<string, readonly string[]>;

export type FiberPart = keyof typeof FIBER_PART_NAMES;

export interface Spelling<T extends string> {
  readonly canonical: T;
  /** The spelling split into words, for matching against tokenized text. */
  readonly words: readonly string[];
}

function spellings<T extends string>(table: Record<T, readonly string[]>): readonly Spelling<T>[] {
  return (Object.entries(table) as [T, readonly string[]][])
    .flatMap(([canonical, names]) =>
      names.map((name): Spelling<T> => ({ canonical, words: name.split(' ') })),
    )
    .sort((a, b) => b.words.length - a.words.length);
}

export const MATERIAL_SPELLINGS = spellings<Material>(MATERIAL_NAMES);
export const FIBER_PART_SPELLINGS = spellings<FiberPart>(FIBER_PART_NAMES);
