/** The parts of a schema that decide whether it is an open enum. */
export interface OpenEnumCandidate {
  anyOf?: readonly { $ref?: string; type?: unknown; enum?: unknown }[];
}

/**
 * The `KnownX` ref of an open enum (`anyOf: [KnownX, string]`), or undefined for any other
 * schema. The one definition used both by code generation (server types narrow open enums
 * to `KnownX`) and by the contract rules (which enforce the open-enum convention).
 */
export function openEnumKnownRef(schema: OpenEnumCandidate): string | undefined {
  if (schema.anyOf?.length !== 2) return undefined;
  const [known, other] = schema.anyOf;
  const ref = known?.$ref;
  if (!ref || !/^#\/components\/schemas\/Known[A-Z]\w*$/.test(ref)) return undefined;
  const isPlainString =
    other?.$ref === undefined && other?.type === 'string' && other.enum === undefined;
  return isPlainString ? ref : undefined;
}
