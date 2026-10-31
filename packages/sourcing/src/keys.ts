/**
 * How the household's items are grouped for sourcing: a brand compared without case, accents,
 * spaces, or punctuation, and a size compared without case or spaces, with letter sizes spelled
 * short. The iPhone matches a tag's brand by the same key (`OwnSalesBucket.brandKey`).
 */

/** The longest key kept; longer brands are cut, so one odd value cannot grow the kit. */
export const MAX_BRAND_KEY_LENGTH = 120;
export const MAX_SIZE_BUCKET_LENGTH = 32;

/**
 * The brand's key: "levis" for "Levi's" and "LEVI’S", "andotherstories" for "& Other Stories".
 * Null when nothing is left of it.
 */
export function brandKey(brand: string | null | undefined): string | null {
  if (brand === null || brand === undefined) return null;
  const key = brand
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, MAX_BRAND_KEY_LENGTH);
  return key === '' ? null : key;
}

/** Spelled-out letter sizes, by their key without spaces or punctuation. */
const LETTER_SIZES: Readonly<Record<string, string>> = {
  xxsmall: 'xxs',
  extraextrasmall: 'xxs',
  xsmall: 'xs',
  extrasmall: 'xs',
  small: 's',
  medium: 'm',
  med: 'm',
  large: 'l',
  xlarge: 'xl',
  extralarge: 'xl',
  xxlarge: 'xxl',
  extraextralarge: 'xxl',
  '2xl': 'xxl',
  xxxlarge: 'xxxl',
  '3xl': 'xxxl',
  onesize: 'os',
  onesizefitsall: 'os',
  osfa: 'os',
};

/** The size's group: "m" for "Medium" and "M", "32x30" for "32 x 30". Null without a size. */
export function sizeBucket(sizeLabel: string | null | undefined): string | null {
  if (sizeLabel === null || sizeLabel === undefined) return null;
  const key = sizeLabel
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_.]/g, '');
  if (key === '') return null;
  return (LETTER_SIZES[key] ?? key).slice(0, MAX_SIZE_BUCKET_LENGTH);
}
