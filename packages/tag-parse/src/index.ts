export { COUNTRY_NAMES } from './countries.ts';
export type { CountryCode } from './countries.ts';
export { gtinCheckDigit, isValidGtin, toGtin } from './gtin.ts';
export { valueKey } from './keys.ts';
export { FIBER_PART_NAMES, MATERIAL_NAMES } from './materials.ts';
export type { FiberPart, Material } from './materials.ts';
export { normalizeText } from './normalize.ts';
export { emptyTagValues, parseTagText, valuesOf } from './parse.ts';
export { TAG_FIELDS } from './types.ts';
export type {
  BarcodeRead,
  FiberComponent,
  Gtin,
  GtinFormat,
  OcrLine,
  Parsed,
  Size,
  SizeSystem,
  TagFacts,
  TagField,
  TagTextInput,
  TagValues,
  TagValueTypes,
  ValueSource,
} from './types.ts';
