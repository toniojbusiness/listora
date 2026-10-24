/**
 * Countries that commonly appear in "Made in ..." lines, keyed by ISO 3166-1 alpha-2 code.
 * Names are normalized (uppercase ASCII, no dots) and include the French, Spanish, Italian, and
 * German spellings found on multilingual care labels.
 */
export const COUNTRY_NAMES = {
  BD: ['BANGLADESH'],
  BG: ['BULGARIA', 'BULGARIE', 'BULGARIEN'],
  BR: ['BRAZIL', 'BRASIL', 'BRESIL', 'BRASILIEN'],
  CA: ['CANADA', 'KANADA'],
  CN: ['CHINA', 'PRC', 'PR CHINA', 'PEOPLES REPUBLIC OF CHINA', 'CHINE', 'CINA'],
  CO: ['COLOMBIA', 'COLOMBIE', 'KOLUMBIEN'],
  DE: ['GERMANY', 'ALLEMAGNE', 'ALEMANIA', 'GERMANIA', 'DEUTSCHLAND'],
  DO: ['DOMINICAN REPUBLIC', 'REPUBLICA DOMINICANA', 'REPUBLIQUE DOMINICAINE'],
  EG: ['EGYPT', 'EGYPTE', 'EGIPTO', 'EGITTO', 'AGYPTEN'],
  ES: ['SPAIN', 'ESPANA', 'ESPAGNE', 'SPAGNA', 'SPANIEN'],
  ET: ['ETHIOPIA', 'ETHIOPIE', 'ETIOPIA'],
  FR: ['FRANCE', 'FRANCIA', 'FRANKREICH'],
  GB: [
    'UNITED KINGDOM',
    'UK',
    'GREAT BRITAIN',
    'ENGLAND',
    'SCOTLAND',
    'ROYAUME-UNI',
    'REINO UNIDO',
  ],
  GT: ['GUATEMALA'],
  HK: ['HONG KONG'],
  HN: ['HONDURAS'],
  HT: ['HAITI'],
  ID: ['INDONESIA', 'INDONESIE', 'INDONESIEN'],
  IN: ['INDIA', 'INDE', 'INDIEN'],
  IT: ['ITALY', 'ITALIA', 'ITALIE', 'ITALIEN'],
  JO: ['JORDAN', 'JORDANIE', 'JORDANIA', 'GIORDANIA', 'JORDANIEN'],
  JP: ['JAPAN', 'JAPON', 'GIAPPONE'],
  KE: ['KENYA'],
  KH: ['CAMBODIA', 'CAMBODGE', 'CAMBOYA', 'CAMBOGIA', 'KAMBODSCHA', 'KAMPUCHEA'],
  KR: ['KOREA', 'SOUTH KOREA', 'REPUBLIC OF KOREA', 'COREE', 'COREA', 'KOREA REPUBLIC'],
  LA: ['LAOS', 'LAO PDR'],
  LK: ['SRI LANKA'],
  MA: ['MOROCCO', 'MAROC', 'MARRUECOS', 'MAROCCO', 'MAROKKO'],
  MG: ['MADAGASCAR'],
  MM: ['MYANMAR', 'BURMA'],
  MX: ['MEXICO', 'MEXIQUE', 'MESSICO', 'MEXIKO'],
  MY: ['MALAYSIA', 'MALAISIE', 'MALASIA'],
  NI: ['NICARAGUA'],
  PE: ['PERU', 'PEROU'],
  PH: ['PHILIPPINES', 'FILIPINAS', 'FILIPPINE', 'PHILIPPINEN'],
  PK: ['PAKISTAN', 'PAQUISTAN'],
  PT: ['PORTUGAL', 'PORTOGALLO'],
  RO: ['ROMANIA', 'ROUMANIE', 'RUMANIA', 'RUMANIEN'],
  SV: ['EL SALVADOR', 'SALVADOR'],
  TH: ['THAILAND', 'THAILANDE', 'TAILANDIA'],
  TN: ['TUNISIA', 'TUNISIE', 'TUNEZ', 'TUNESIEN'],
  TR: ['TURKEY', 'TURKIYE', 'TURQUIE', 'TURQUIA', 'TURCHIA', 'TURKEI'],
  TW: ['TAIWAN'],
  US: [
    'USA',
    'US',
    'UNITED STATES',
    'UNITED STATES OF AMERICA',
    'AMERICA',
    'ETATS-UNIS',
    'ESTADOS UNIDOS',
  ],
  VN: ['VIETNAM', 'VIET NAM', 'VIET-NAM'],
} as const satisfies Record<string, readonly string[]>;

export type CountryCode = keyof typeof COUNTRY_NAMES;

interface CountryName {
  readonly code: CountryCode;
  readonly name: string;
}

/** Every spelling, longest first, so "UNITED STATES OF AMERICA" wins over "UNITED STATES". */
export const COUNTRY_SPELLINGS: readonly CountryName[] = Object.entries(COUNTRY_NAMES)
  .flatMap(([code, names]) =>
    names.map((name): CountryName => ({ code: code as CountryCode, name })),
  )
  .sort((a, b) => b.name.length - a.name.length);
