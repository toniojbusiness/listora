import { emptyTagValues, isValidGtin, type BarcodeRead, type TagValues } from '@listora/tag-parse';

import { humanReadable } from './barcode.ts';
import type { CaseSpec, PrintedBlock } from './types.ts';

/*
 * Hand-written cases for the traps a parser must handle: lookalike numbers that are not
 * identifiers, wrapped and merged lines, and multilingual repeats. Unless a case gives its own
 * OCR lines, OCR reads the printed text exactly and every valid barcode decodes.
 */

interface EdgeOptions {
  /** OCR lines that differ from the printed text (misreads, wraps, merges). */
  readonly ocrLines?: readonly string[];
  readonly barcodes?: readonly BarcodeRead[];
}

function edge(
  number: number,
  description: string,
  printed: readonly (string | { barcode: string })[],
  truth: Partial<TagValues>,
  options: EdgeOptions = {},
): CaseSpec {
  const blocks: PrintedBlock[] = printed.map((block) =>
    typeof block === 'string' ? { text: block } : block,
  );
  const lines =
    options.ocrLines ??
    blocks.map((block) => ('text' in block ? block.text : humanReadable(block.barcode)));
  const barcodes =
    options.barcodes ??
    blocks.flatMap((block): BarcodeRead[] =>
      'barcode' in block && isValidGtin(block.barcode)
        ? [
            {
              payload: block.barcode.length === 12 ? `0${block.barcode}` : block.barcode,
              symbology: 'VNBarcodeSymbologyEAN13',
            },
          ]
        : [],
    );
  return {
    id: `edge-case-${String(number).padStart(3, '0')}`,
    kind: 'edge_case',
    description,
    printed: blocks,
    ocr: { lines: lines.map((text) => ({ text, confidence: 1 })), barcodes },
    truth: { ...emptyTagValues(), ...truth },
  };
}

export const EDGE_CASES: readonly CaseSpec[] = [
  edge(
    1,
    'A California ZIP code after a comma is an address, not a CA number',
    ['HARBOR LANE', 'LOS ANGELES, CA 90012', 'RN 141526', 'MADE IN USA'],
    { rn: ['141526'], origin: ['US'] },
  ),
  edge(
    2,
    'A printed barcode with a wrong check digit is rejected; scanners do not decode it',
    ['COPPER FOX', 'STYLE # 418822', { barcode: '036000291453' }, 'SIZE M'],
    { style: ['418822'], size: [{ system: 'letter', value: 'M' }] },
  ),
  edge(
    3,
    '"Designed in" is not a country of origin',
    ['DESIGNED IN CALIFORNIA', 'MADE IN CHINA', '100% COTTON'],
    { origin: ['CN'], fiber: [{ part: null, material: 'cotton', percent: 100 }] },
  ),
  edge(4, '"Imported" names no country', ['WILLOW STREET', 'IMPORTED', 'SIZE L', 'RN 52114'], {
    size: [{ system: 'letter', value: 'L' }],
    rn: ['52114'],
  }),
  edge(
    5,
    'A style label followed by words is not a style number',
    ['STYLE MEETS COMFORT', 'ITEM # 20931-004', 'ONE SIZE'],
    { style: ['20931-004'], size: [{ system: 'one_size', value: 'OS' }] },
  ),
  edge(
    6,
    'One composition repeated in three languages counts once',
    ['60% COTTON 40% POLYESTER', '60% COTON 40% POLYESTER', '60% ALGODON 40% POLIESTER'],
    {
      fiber: [
        { part: null, material: 'cotton', percent: 60 },
        { part: null, material: 'polyester', percent: 40 },
      ],
    },
  ),
  edge(
    7,
    'Translated part labels before a colon',
    ['SHELL/EXTERIOR: 100% NYLON', 'LINING/FORRO: 100% POLYESTER', 'HECHO EN VIETNAM'],
    {
      fiber: [
        { part: 'shell', material: 'nylon', percent: 100 },
        { part: 'lining', material: 'polyester', percent: 100 },
      ],
      origin: ['VN'],
    },
  ),
  edge(
    8,
    '"Exclusive of trim" does not create a trim part',
    ['100% COTTON EXCLUSIVE OF TRIM', 'MADE IN INDIA'],
    { fiber: [{ part: null, material: 'cotton', percent: 100 }], origin: ['IN'] },
  ),
  edge(
    9,
    'Origin with a trailing qualifier',
    ['MADE IN U.S.A. OF IMPORTED MATERIALS', 'RN 98765'],
    { origin: ['US'], rn: ['98765'] },
  ),
  edge(
    10,
    'A multilingual size label wrapped onto its own line',
    ['TALLA/SIZE/TAILLE', 'M', 'MADE IN BANGLADESH'],
    { size: [{ system: 'letter', value: 'M' }], origin: ['BD'] },
  ),
  edge(
    11,
    '"MADE IN" wrapped onto the next line',
    ['MADE IN', 'VIET NAM', '95% COTTON 5% SPANDEX'],
    {
      origin: ['VN'],
      fiber: [
        { part: null, material: 'cotton', percent: 95 },
        { part: null, material: 'spandex', percent: 5 },
      ],
    },
  ),
  edge(
    12,
    'Shoe sizes with halves in three systems',
    ['US 10.5 UK 9.5 EUR 44.5', 'ART. NO. GX4417-02', 'MADE IN INDONESIA'],
    {
      size: [
        { system: 'us', value: '10.5' },
        { system: 'uk', value: '9.5' },
        { system: 'eu', value: '44.5' },
      ],
      style: ['GX4417-02'],
      origin: ['ID'],
    },
  ),
  edge(13, "Women's size in US, UK, and EU systems", ['US 8 / UK 12 / EU 40', 'MADE IN TURKEY'], {
    size: [
      { system: 'us', value: '8' },
      { system: 'uk', value: '12' },
      { system: 'eu', value: '40' },
    ],
    origin: ['TR'],
  }),
  edge(
    14,
    'OCR misreads inside an RN and a CA number',
    ['RN#150722', 'CA 34018'],
    { rn: ['150722'], ca: ['34018'] },
    { ocrLines: ['RN#I5O722', 'CA 34OI8'] },
  ),
  edge(
    15,
    'Words that contain "RN" are not RN numbers',
    ['PATTERN 20817', 'RETURN POLICY 30 DAYS', 'BRN 22145'],
    {},
  ),
  edge(
    16,
    'A brand containing a size word is not a size',
    ['XL ATHLETICS', 'SIZE S', 'MADE IN PAKISTAN'],
    { size: [{ system: 'letter', value: 'S' }], origin: ['PK'] },
  ),
  edge(
    17,
    'Several facts merged onto one OCR line',
    ['SIZE M', 'MADE IN CHINA', 'RN 41235'],
    { size: [{ system: 'letter', value: 'M' }], origin: ['CN'], rn: ['41235'] },
    { ocrLines: ['SIZE M MADE IN CHINA RN 41235'] },
  ),
  edge(
    18,
    'Vision reports a UPC-A as a 13-digit EAN-13 with a leading zero',
    ['BLUE CEDAR', { barcode: '036000291452' }],
    { gtin: [{ format: 'upc_a', digits: '036000291452' }] },
  ),
  edge(
    19,
    'An EAN-13 read from printed digits only (bars not decoded)',
    ['QUIET HARBOR', { barcode: '5901234123457' }],
    { gtin: [{ format: 'ean_13', digits: '5901234123457' }] },
    { barcodes: [] },
  ),
  edge(
    20,
    'Waist and inseam without a label, alone on the line',
    ['STONE RIVER DENIM', '32X34', 'MADE IN MEXICO'],
    { size: [{ system: 'waist_inseam', value: '32x34' }], origin: ['MX'] },
  ),
  edge(21, 'Material before percentage', ['COTTON 60% POLYESTER 40%', 'MADE IN GUATEMALA'], {
    fiber: [
      { part: null, material: 'cotton', percent: 60 },
      { part: null, material: 'polyester', percent: 40 },
    ],
    origin: ['GT'],
  }),
  edge(22, 'RN and CA numbers on one line', ['RN 62914 CA 18823', 'PRODUCT OF CANADA'], {
    rn: ['62914'],
    ca: ['18823'],
    origin: ['CA'],
  }),
  edge(23, 'A bare numeric size alone on a size tab', ['8', 'OAK HOLLOW', 'MADE IN SRI LANKA'], {
    size: [{ system: 'numeric', value: '8' }],
    origin: ['LK'],
  }),
  edge(24, 'Multi-word materials', ['70% MERINO WOOL 25% NYLON 5% OTHER FIBERS', 'MADE IN ITALY'], {
    fiber: [
      { part: null, material: 'merino_wool', percent: 70 },
      { part: null, material: 'nylon', percent: 25 },
      { part: null, material: 'other', percent: 5 },
    ],
    origin: ['IT'],
  }),
  edge(
    25,
    'A composition continued on the next line keeps its part',
    ['SHELL: 60% COTTON', '40% POLYESTER', 'LINING: 100% POLYESTER'],
    {
      fiber: [
        { part: 'shell', material: 'cotton', percent: 60 },
        { part: 'shell', material: 'polyester', percent: 40 },
        { part: 'lining', material: 'polyester', percent: 100 },
      ],
    },
  ),
  edge(
    26,
    'A multilingual origin line names one country',
    ['MADE IN CHINA / FABRIQUE EN CHINE / HECHO EN CHINA', 'S/P/CH'],
    { origin: ['CN'], size: [{ system: 'letter', value: 'S' }] },
  ),
  edge(27, 'A ZIP+4 after "CA" is an address', ['SAN DIEGO CA 92101-4213', 'CA 55103'], {
    ca: ['55103'],
  }),
  edge(
    28,
    'Prices and quantities are not sizes or style numbers',
    ['MSRP $48.00', '2 PACK', 'SIZE: XL', 'MODEL: TR-4410'],
    { size: [{ system: 'letter', value: 'XL' }], style: ['TR-4410'] },
  ),
];
