import type { CountryCode, Material } from '@listora/tag-parse';

/*
 * Words the generator prints. Brands, cities, and domains are fictional; numbers are random.
 * Nothing here is copied from a real tag, and no value is meant to identify a real company,
 * product, or registration.
 */

export const BRANDS = [
  'NORTHWIND APPAREL',
  'HARBOR LANE',
  'FIELD AND FERN',
  'OAK HOLLOW',
  'MERIDIAN WORKS',
  'SALT FLATS SUPPLY',
  'BLUE CEDAR',
  'LITTLE ATLAS',
  'STONE RIVER DENIM',
  'PARALLEL ATHLETIC',
  'KITE AND KESTREL',
  'JUNIPER CO.',
  'QUIET HARBOR',
  'WILLOW STREET',
  'COPPER FOX',
] as const;

/** Printed country names, first is the most common spelling, then French and Spanish. */
export const COUNTRY_DISPLAY: Readonly<
  Partial<Record<CountryCode, { names: readonly string[]; fr?: string; es?: string }>>
> = {
  CN: { names: ['CHINA', 'P.R.C.', 'CHINA'], fr: 'CHINE', es: 'CHINA' },
  VN: { names: ['VIETNAM', 'VIET NAM'], fr: 'VIETNAM', es: 'VIETNAM' },
  BD: { names: ['BANGLADESH'], fr: 'BANGLADESH', es: 'BANGLADESH' },
  IN: { names: ['INDIA'], fr: 'INDE', es: 'INDIA' },
  ID: { names: ['INDONESIA'], fr: 'INDONESIE', es: 'INDONESIA' },
  KH: { names: ['CAMBODIA'], fr: 'CAMBODGE', es: 'CAMBOYA' },
  MX: { names: ['MEXICO'], fr: 'MEXIQUE', es: 'MEXICO' },
  US: {
    names: ['USA', 'U.S.A.', 'THE USA', 'UNITED STATES'],
    fr: 'ETATS-UNIS',
    es: 'ESTADOS UNIDOS',
  },
  TR: { names: ['TURKEY', 'TURKIYE'], fr: 'TURQUIE', es: 'TURQUIA' },
  PT: { names: ['PORTUGAL'], fr: 'PORTUGAL', es: 'PORTUGAL' },
  IT: { names: ['ITALY'], fr: 'ITALIE', es: 'ITALIA' },
  GT: { names: ['GUATEMALA'], es: 'GUATEMALA' },
  HN: { names: ['HONDURAS'], es: 'HONDURAS' },
  SV: { names: ['EL SALVADOR'], es: 'EL SALVADOR' },
  LK: { names: ['SRI LANKA'] },
  PK: { names: ['PAKISTAN'] },
  TH: { names: ['THAILAND'], fr: 'THAILANDE', es: 'TAILANDIA' },
  CA: { names: ['CANADA'], fr: 'CANADA', es: 'CANADA' },
  PE: { names: ['PERU'], es: 'PERU' },
  JO: { names: ['JORDAN'] },
  EG: { names: ['EGYPT'] },
  KR: { names: ['KOREA', 'SOUTH KOREA'] },
  MY: { names: ['MALAYSIA'] },
  PH: { names: ['PHILIPPINES'] },
  MA: { names: ['MOROCCO'], fr: 'MAROC' },
  RO: { names: ['ROMANIA'] },
  JP: { names: ['JAPAN'], fr: 'JAPON', es: 'JAPON' },
};

/** Weighted toward the countries that dominate resale apparel. */
export const ORIGIN_POOL: readonly CountryCode[] = [
  'CN',
  'CN',
  'CN',
  'CN',
  'VN',
  'VN',
  'VN',
  'BD',
  'BD',
  'IN',
  'IN',
  'ID',
  'KH',
  'MX',
  'US',
  'US',
  'TR',
  'PT',
  'IT',
  'GT',
  'HN',
  'SV',
  'LK',
  'PK',
  'TH',
  'CA',
  'PE',
  'JO',
  'EG',
  'KR',
  'MY',
  'PH',
  'MA',
  'RO',
  'JP',
];

/** Printed material names in English (with an EU variant), French, and Spanish. */
export const MATERIAL_DISPLAY: Readonly<
  Record<Material, { en: readonly string[]; fr: string; es: string }>
> = {
  acetate: { en: ['ACETATE'], fr: 'ACETATE', es: 'ACETATO' },
  acrylic: { en: ['ACRYLIC'], fr: 'ACRYLIQUE', es: 'ACRILICO' },
  alpaca: { en: ['ALPACA'], fr: 'ALPAGA', es: 'ALPACA' },
  angora: { en: ['ANGORA'], fr: 'ANGORA', es: 'ANGORA' },
  cashmere: { en: ['CASHMERE'], fr: 'CACHEMIRE', es: 'CACHEMIRA' },
  cotton: { en: ['COTTON'], fr: 'COTON', es: 'ALGODON' },
  hemp: { en: ['HEMP'], fr: 'CHANVRE', es: 'CANAMO' },
  leather: { en: ['LEATHER'], fr: 'CUIR', es: 'CUERO' },
  linen: { en: ['LINEN'], fr: 'LIN', es: 'LINO' },
  lyocell: { en: ['LYOCELL', 'TENCEL'], fr: 'LYOCELL', es: 'LYOCELL' },
  merino_wool: { en: ['MERINO WOOL'], fr: 'LAINE MERINOS', es: 'LANA MERINO' },
  metallic: { en: ['METALLIC FIBER', 'METALLIC'], fr: 'METALLISEE', es: 'METALIZADA' },
  modal: { en: ['MODAL'], fr: 'MODAL', es: 'MODAL' },
  mohair: { en: ['MOHAIR'], fr: 'MOHAIR', es: 'MOHAIR' },
  nylon: { en: ['NYLON', 'POLYAMIDE'], fr: 'POLYAMIDE', es: 'NAILON' },
  other: { en: ['OTHER FIBERS', 'OTHER FIBER'], fr: 'AUTRES FIBRES', es: 'OTRAS FIBRAS' },
  polyester: { en: ['POLYESTER'], fr: 'POLYESTER', es: 'POLIESTER' },
  polyurethane: { en: ['POLYURETHANE'], fr: 'POLYURETHANNE', es: 'POLIURETANO' },
  rayon: { en: ['RAYON'], fr: 'RAYONNE', es: 'RAYON' },
  silk: { en: ['SILK'], fr: 'SOIE', es: 'SEDA' },
  spandex: { en: ['SPANDEX', 'ELASTANE'], fr: 'ELASTHANNE', es: 'ELASTANO' },
  viscose: { en: ['VISCOSE'], fr: 'VISCOSE', es: 'VISCOSA' },
  wool: { en: ['WOOL'], fr: 'LAINE', es: 'LANA' },
};

/** Fiber blends as [material, percent] lists that sum to 100. */
export const BLENDS: readonly (readonly (readonly [Material, number])[])[] = [
  [['cotton', 100]],
  [['cotton', 100]],
  [['polyester', 100]],
  [
    ['cotton', 60],
    ['polyester', 40],
  ],
  [
    ['cotton', 50],
    ['polyester', 50],
  ],
  [
    ['cotton', 98],
    ['spandex', 2],
  ],
  [
    ['cotton', 95],
    ['spandex', 5],
  ],
  [
    ['polyester', 88],
    ['spandex', 12],
  ],
  [
    ['nylon', 80],
    ['spandex', 20],
  ],
  [
    ['rayon', 95],
    ['spandex', 5],
  ],
  [
    ['viscose', 70],
    ['nylon', 30],
  ],
  [
    ['wool', 80],
    ['nylon', 20],
  ],
  [
    ['cotton', 60],
    ['polyester', 35],
    ['spandex', 5],
  ],
  [
    ['polyester', 65],
    ['rayon', 30],
    ['spandex', 5],
  ],
  [
    ['acrylic', 70],
    ['wool', 30],
  ],
  [
    ['acrylic', 50],
    ['nylon', 30],
    ['wool', 20],
  ],
  [['cashmere', 100]],
  [['silk', 100]],
  [['linen', 100]],
  [
    ['linen', 55],
    ['cotton', 45],
  ],
  [
    ['modal', 50],
    ['cotton', 50],
  ],
  [['lyocell', 100]],
  [['merino_wool', 100]],
  [
    ['cotton', 95],
    ['other', 5],
  ],
  [
    ['viscose', 97],
    ['metallic', 3],
  ],
  [
    ['alpaca', 60],
    ['acrylic', 40],
  ],
  [
    ['mohair', 40],
    ['acrylic', 40],
    ['nylon', 20],
  ],
  [
    ['hemp', 55],
    ['cotton', 45],
  ],
  [['acetate', 100]],
];

export const OUTERWEAR_PARTS = [
  { shell: [['nylon', 100]], lining: [['polyester', 100]] },
  { shell: [['polyester', 100]], lining: [['polyester', 100]], fill: [['polyester', 100]] },
  {
    shell: [
      ['wool', 70],
      ['nylon', 30],
    ],
    lining: [['acetate', 100]],
  },
  { shell: [['cotton', 100]], lining: [['polyester', 100]] },
  {
    body: [
      ['cotton', 95],
      ['spandex', 5],
    ],
    rib: [['cotton', 100]],
  },
  { shell: [['leather', 100]], lining: [['polyester', 100]] },
  { body: [['polyester', 100]], contrast: [['nylon', 100]] },
] as const satisfies readonly Partial<Record<string, readonly (readonly [Material, number])[]>>[];

export const CARE_LINES = [
  'MACHINE WASH COLD',
  'MACHINE WASH COLD WITH LIKE COLORS',
  'TUMBLE DRY LOW',
  'DO NOT BLEACH',
  'COOL IRON IF NEEDED',
  'DRY CLEAN ONLY',
  'LINE DRY',
  'HAND WASH COLD',
  'LAY FLAT TO DRY',
  'DO NOT DRY CLEAN',
  'WASH INSIDE OUT',
  'LAVAR A MAQUINA EN FRIO',
  'NO USAR BLANQUEADOR',
  'LAVER A LA MACHINE A FROID',
  'NE PAS BLANCHIR',
  'SEE REVERSE FOR CARE',
] as const;

export const CALIFORNIA_ADDRESSES = [
  ['LOS ANGELES', '900'],
  ['SAN FRANCISCO', '941'],
  ['SAN DIEGO', '921'],
  ['OAKLAND', '946'],
] as const;

export const OTHER_ADDRESSES = ['NEW YORK, NY 10018', 'PORTLAND, OR 97209', 'SEATTLE, WA 98104'];

export const DISTRACTORS = [
  'DESIGNED IN CALIFORNIA',
  'DESIGNED IN BROOKLYN',
  'IMPORTED',
  'STYLE MEETS COMFORT',
  'QUALITY SINCE 1987',
  'PATTERN 20817',
  'RETURN POLICY 30 DAYS',
  'FITS LIKE A LARGE',
  'ORDER 5512 BATCH 7',
] as const;
