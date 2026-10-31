/**
 * How the sourcing kit groups sizes: compared without case or spaces, with letter sizes spelled
 * short, so "Medium" and "M" are one group (`OwnSalesBucket.sizeBucket`).
 */

/** The longest size kept; longer ones are cut, so one odd value cannot grow the kit. */
export const MAX_SIZE_BUCKET_LENGTH = 32;

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
