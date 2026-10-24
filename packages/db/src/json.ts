import { sql, type RawBuilder } from 'kysely';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export type JsonArray = JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Wraps a value for a `jsonb` column. node-postgres would send a JavaScript array as a
 * Postgres array literal rather than JSON, so jsonb values are always serialized explicitly.
 */
export function jsonb<T extends JsonValue>(value: T): RawBuilder<T> {
  return sql<T>`cast(${JSON.stringify(value)} as jsonb)`;
}
