import type { TagField, TagValueTypes } from './types.ts';

const KEYS: { readonly [F in TagField]: (value: TagValueTypes[F]) => string } = {
  rn: (value) => value,
  ca: (value) => value,
  gtin: (value) => `${value.format}:${value.digits}`,
  size: (value) => `${value.system}:${value.value}`,
  fiber: (value) => `${value.part ?? '-'}:${value.material}:${String(value.percent)}`,
  origin: (value) => value,
  style: (value) => value,
};

/** A canonical string for a value: equal keys mean the same fact. Used to dedupe and to score. */
export function valueKey<F extends TagField>(field: F, value: TagValueTypes[F]): string {
  return KEYS[field](value);
}
