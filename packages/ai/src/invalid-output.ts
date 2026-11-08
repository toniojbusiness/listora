/**
 * What a model wrote that its schema refused, in a form safe for the logs: each issue's path
 * and rule, and the value the model gave there, shortened and with contact details masked. The
 * whole answer is never logged (it carries the item's full listing copy), only the values the
 * schema refused, so a log line shows which vocabulary or rule the model missed.
 */
import type { z } from 'zod';

/** One refused value. */
export interface InvalidOutputIssue {
  /** Where in the answer, for example `attributes.colors.0`. */
  readonly path: string;
  /** Zod's issue code, for example `invalid_value` or `invalid_format`. */
  readonly code: string;
  /** The value the model gave there, redacted (`describeValue`). */
  readonly received: string;
}

/** Why an answer was refused, as the logs carry it. */
export type InvalidOutputDetail =
  | { readonly kind: 'not_json'; readonly length: number; readonly start: string }
  | { readonly kind: 'schema'; readonly issues: readonly InvalidOutputIssue[] };

/** The most issues one log line carries; a broken answer can break many rules at once. */
export const MAX_LOGGED_ISSUES = 10;
/** The most characters of one refused value the logs keep. */
export const MAX_LOGGED_VALUE_LENGTH = 60;

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
// Seven or more digits, with the separators phone numbers use between them.
const PHONE = /\+?\d[\d\s().-]{5,}\d/g;
const URL_TEXT = /\bhttps?:\/\/\S+/gi;

/** A string with contact details masked and cut to `MAX_LOGGED_VALUE_LENGTH`. */
export function redactText(text: string): string {
  const masked = text
    .replace(URL_TEXT, '<url>')
    .replace(EMAIL, '<email>')
    .replace(PHONE, '<number>');
  return masked.length <= MAX_LOGGED_VALUE_LENGTH
    ? masked
    : `${masked.slice(0, MAX_LOGGED_VALUE_LENGTH)}… (${String(text.length)} chars)`;
}

/** A value as the logs show it: text redacted, a list or object by its size, not its content. */
export function describeValue(value: unknown): string {
  if (value === undefined) return '(missing)';
  if (typeof value === 'string') return JSON.stringify(redactText(value));
  if (Array.isArray(value)) return `(list of ${String(value.length)})`;
  if (typeof value === 'object' && value !== null) {
    return `(object: ${Object.keys(value).slice(0, MAX_LOGGED_ISSUES).join(', ')})`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return `(${typeof value})`;
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let node = root;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
}

/** The refused values of an answer that parsed as JSON but broke its schema. */
export function schemaIssues(answer: unknown, error: z.ZodError): InvalidOutputDetail {
  return {
    kind: 'schema',
    issues: error.issues.slice(0, MAX_LOGGED_ISSUES).map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
      received: describeValue(valueAt(answer, issue.path)),
    })),
  };
}

/** An answer that is not JSON: its length and how it starts. */
export function notJson(text: string): InvalidOutputDetail {
  return { kind: 'not_json', length: text.length, start: redactText(text.trimStart()) };
}
