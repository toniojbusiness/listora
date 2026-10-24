/** A JSON-compatible value produced by `redactForStorage`. */
export type RedactedValue =
  string | number | boolean | null | RedactedValue[] | { [key: string]: RedactedValue };

export const REDACTED = '[redacted]';
export const TRUNCATED = '[truncated]';

/**
 * Key fragments that mark a credential. A key matches when its letters, lowercased, contain one
 * of them, so `accessToken`, `refresh_token`, `X-Api-Key`, and `clientSecret` all match. This is
 * a superset of the exact field names that `REDACTED_LOG_PATHS` removes from logs.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'credential',
] as const;

export function isSensitiveKey(key: string): boolean {
  const letters = key.toLowerCase().replace(/[^a-z]/g, '');
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => letters.includes(fragment));
}

export interface RedactOptions {
  /** Objects and arrays nested deeper than this are replaced by `[truncated]`. */
  maxDepth?: number;
  /** Longer strings are cut to this many characters, then marked `[truncated]`. */
  maxStringLength?: number;
  /** Longer arrays keep this many items, then a `[truncated]` marker. */
  maxArrayLength?: number;
}

/**
 * Makes a value safe to store as a history excerpt (for example `operation_event.detail`):
 * credential-like keys are replaced by `[redacted]` at every depth, long strings and arrays are
 * cut, and the result is plain JSON. Errors keep only their name and message.
 */
export function redactForStorage(value: unknown, options: RedactOptions = {}): RedactedValue {
  const limits = {
    maxDepth: options.maxDepth ?? 6,
    maxStringLength: options.maxStringLength ?? 500,
    maxArrayLength: options.maxArrayLength ?? 50,
  };
  return redactValue(value, 0, limits) ?? null;
}

function redactValue(
  value: unknown,
  depth: number,
  limits: Required<RedactOptions>,
): RedactedValue | undefined {
  switch (typeof value) {
    case 'string':
      return value.length > limits.maxStringLength
        ? `${value.slice(0, limits.maxStringLength)}${TRUNCATED}`
        : value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'object':
      break;
  }
  if (value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactValue(value.message, depth, limits) ?? null };
  }
  if (depth >= limits.maxDepth) return TRUNCATED;

  if (Array.isArray(value)) {
    const items = value
      .slice(0, limits.maxArrayLength)
      .map((item) => redactValue(item, depth + 1, limits) ?? null);
    if (value.length > limits.maxArrayLength) items.push(TRUNCATED);
    return items;
  }

  const result: Record<string, RedactedValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
      continue;
    }
    const redacted = redactValue(item, depth + 1, limits);
    if (redacted !== undefined) result[key] = redacted;
  }
  return result;
}
