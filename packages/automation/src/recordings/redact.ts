/**
 * Redaction of a recording (recording.ts) before it is written: no personal data and no
 * credential leaves the recording session.
 *
 * - **Who is on the page.** Values the page's data names as a person's (usernames and handles,
 *   names, email addresses, phone numbers, street addresses, and user ids: by their keys, in
 *   the data globals, the API's answers, and the JSON in the document, however often it is
 *   escaped) are collected, with the words the marketplace's plan knows identify the seller (the
 *   username in Depop's product slugs) and any the person recording adds. Every occurrence of
 *   each, anywhere in the recording (addresses, documents, data, selectors, results), becomes a
 *   placeholder of the same kind (`user1`, `Name1`, `user1@example.com`), the same one each
 *   time, so a slug, a link, and the data that names it still agree.
 * - **Credentials.** Values under keys that name a token, secret, password, session, or
 *   signature become `REDACTED`, as do JSON web tokens, long opaque tokens, and token-like query
 *   parameters.
 * - **Anything else personal.** Any other email address or phone number is replaced, and every
 *   image address (the seller's photos and avatar) becomes a placeholder image's.
 *
 * `unredacted` checks a recording afterwards: the recorder writes none it finds anything in,
 * and a test runs it over every committed recording.
 */
import type { ExpandedRecording } from './recording.ts';

type TermKind = 'user' | 'name' | 'email' | 'phone' | 'address' | 'id' | 'secret';
/** A value found, its kind, and the key it was under (`null` for one given by name). */
interface Term {
  kind: TermKind;
  key: string | null;
}

/** Keys whose value names a person or their account, by kind. */
const IDENTITY_KEYS: readonly (readonly [RegExp, TermKind])[] = [
  // `screen_name` is a handle; Poshmark's `screenName` (camel case) is its analytics' name for the
  // page (`my_offers`), so it is not one.
  [/^screen_name$/, 'user'],
  [/^(user_?name|login|handle|display_?handle|nick_?name|seller_?handle)$/i, 'user'],
  [
    /^(first_?name|last_?name|full_?name|real_?name|given_?name|family_?name|seller_?name|buyer_?name|recipient_?name|shipping_?name)$/i,
    'name',
  ],
  // What a seller wrote about themselves, which names them as well as a name does.
  [/^(introduction|bio|biography|about|about_?me|profile_?description|tagline)$/i, 'name'],
  [/^(email|e_?mail_?address|email_?address|contact_?email|paypal_?email)$/i, 'email'],
  [/^(phone|phone_?number|mobile|mobile_?number|telephone)$/i, 'phone'],
  [
    /^(address|full_?address|formatted_?address|street|street_?address|street\d|street_?line_?\d|address_?line_?\d|address\d|line_?[12]|postal_?code|post_?code|zip|zip_?code|city|town)$/i,
    'address',
  ],
  [
    /^(user_?id|seller_?id|buyer_?id|owner_?id|member_?id|customer_?id|account_?id|creator_?id|uid|profile_?id)$/i,
    'id',
  ],
  [
    /(token|secret|password|passwd|csrf|xsrf|session_?id|session_?token|api_?key|signature|auth_?code|cookie)$/i,
    'secret',
  ],
];

/** A `name` under one of these keys is a person's. */
const PERSON_PARENT =
  /(user|seller|buyer|owner|profile|recipient|customer|member|account|creator|author|sender|shipping|billing|address|viewer|me)$/i;

/** Values that name nobody. */
const NOT_A_NAME = new Set(['null', 'undefined', 'true', 'false', 'none', 'n/a', 'unknown']);

/** What every redaction left: a value matching one of these is a placeholder. */
const PLACEHOLDER =
  /^(user\d+|Name\d+|user\d*@example\.com|555-555-01\d\d|Redacted|REDACTED\d*|9?0+\d{1,4}|id\d+)$/;

/** `"key": "value"` in JSON text, escaped any number of times (Depop's payload is twice). */
const KEYED_TEXT =
  /\\{0,7}"([A-Za-z][A-Za-z0-9_]{1,40})\\{0,7}"\s*:\s*(?:\\{0,7}"([^"\\]{1,200})\\{0,7}"|(\d{4,20})(?![\d.]))/g;

/** An HTML attribute naming a person (`data-username="..."`). */
const KEYED_ATTRIBUTE =
  /\s(?:data-)?(user-?name|username|handle|email|seller|buyer)="([^"&]{3,200})"/gi;

const EMAIL =
  /[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const PHONE = /(?<![\d-])(?:\+?1[-. ])?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?![\d-])/g;
/** A long run of letters and digits with both, as session ids and signatures are. */
const LONG_TOKEN =
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g;
const TOKEN_PARAMETER =
  /([?&](?:[A-Za-z_]*token|auth|sig|signature|key|session|code|ticket)=)([^&"'\s<>]+)/gi;
/** An image's address, its slashes escaped or not (`https:\/\/` in JSON inside a script). */
const IMAGE_URL =
  /https?:(?:\\?\/){2}(?:[^\s"'\\<>(),]|\\\/)+?\.(jpe?g|png|webp|gif|avif|heic)(?:\?[^\s"'\\<>(),]*)?(?=[\s"'\\<>(),]|$)/gi;
/** Where image addresses point instead; a replay answers every image with a placeholder. */
export const REPLAY_IMAGE_ORIGIN = 'https://images.recorded.invalid';

export interface RedactionOptions {
  /** Words known to identify the seller (their username), redacted as usernames. */
  identity?: readonly string[];
  /** The texts of the pages' private parts (a buyer's name, an address), redacted as names. */
  privateTexts?: readonly string[];
  /**
   * Listora's own words in the recording (the sample listing a form entry fills in): never
   * anyone's, so no value they contain is redacted, even under a person's key.
   */
  keep?: readonly string[];
}

/** What a redaction replaced, by kind: counts only, never the values. */
export type RedactionReport = Partial<Record<TermKind | 'image', number>>;

/**
 * The recordings of one session with everything personal and every credential replaced, each
 * value by the same placeholder in all of them.
 */
export function redactRecordings(
  recordings: readonly ExpandedRecording[],
  options: RedactionOptions = {},
): { recordings: ExpandedRecording[]; report: RedactionReport } {
  // Again while a pass leaves a value under a person's key (one whose every occurrence the first
  // pass could not tell apart from the words around it), at most a few times.
  let pass = redactOnce(recordings, options, 0);
  const report: RedactionReport = { ...pass.report };
  for (
    let again = 0;
    again < 3 && pass.recordings.some((each) => leftover(each, options));
    again += 1
  ) {
    // Numbered on from the earlier passes' placeholders, so none means two values.
    pass = redactOnce(pass.recordings, options, 100 * (again + 1));
    for (const [kind, count] of Object.entries(pass.report) as [keyof RedactionReport, number][]) {
      report[kind] = (report[kind] ?? 0) + count;
    }
  }
  return { recordings: pass.recordings, report };
}

function leftover(recording: ExpandedRecording, options: RedactionOptions): boolean {
  const kept = (options.keep ?? []).map((text) => text.toLowerCase());
  for (const term of collectTerms(recording).keys()) {
    if (!PLACEHOLDER.test(term) && !kept.some((text) => text.includes(term.toLowerCase())))
      return true;
  }
  return false;
}

function redactOnce(
  recordings: readonly ExpandedRecording[],
  options: RedactionOptions,
  offset: number,
): { recordings: ExpandedRecording[]; report: RedactionReport } {
  const terms = collectTerms(recordings);
  for (const word of options.identity ?? []) addTerm(terms, word, 'user');
  for (const text of options.privateTexts ?? []) addTerm(terms, text, 'name');
  const kept = (options.keep ?? []).map((text) => text.toLowerCase());
  for (const term of [...terms.keys()]) {
    if (kept.some((text) => text.includes(term.toLowerCase()))) terms.delete(term);
  }
  const report: RedactionReport = {};
  const replacements = new Map<string, string>();
  const counters: Partial<Record<TermKind, number>> = {};
  // Longest first, so a full name goes before its first name, an email before its username.
  const ordered = [...terms].sort(([a], [b]) => b.length - a.length);
  for (const [term, { kind }] of ordered) {
    const number = (counters[kind] = (counters[kind] ?? 0) + 1);
    report[kind] = number;
    const placeholder = placeholderFor(kind, number + offset, term);
    replacements.set(term.toLowerCase(), placeholder);
    const encoded = encodeURIComponent(term);
    if (encoded !== term) replacements.set(encoded.toLowerCase(), encodeURIComponent(placeholder));
  }
  const pattern =
    replacements.size === 0
      ? null
      : new RegExp(
          `(?<![A-Za-z0-9])(?:${[...replacements.keys()]
            .sort((a, b) => b.length - a.length)
            .map(escapeRegExp)
            .join('|')})(?![A-Za-z0-9])`,
          'gi',
        );
  const images = new Map<string, string>();
  const tokens = new Map<string, string>();
  // The same token is the same placeholder each time, so a cursor still leads to its page.
  const token = (found: string): string => {
    let placeholder = tokens.get(found);
    if (placeholder === undefined) {
      placeholder = `REDACTED${String(tokens.size + 1)}`;
      tokens.set(found, placeholder);
    }
    return placeholder;
  };
  const redact = (text: string): string => {
    let out =
      pattern === null
        ? text
        : text.replace(pattern, (found) => replacements.get(found.toLowerCase()) ?? found);
    out = out
      .replace(IMAGE_URL, (url, extension: string) => {
        let placeholder = images.get(url);
        if (placeholder === undefined) {
          placeholder = `${REPLAY_IMAGE_ORIGIN}/${String(images.size + 1)}.${extension.toLowerCase()}`;
          images.set(url, placeholder);
        }
        return placeholder;
      })
      .replace(JWT, token)
      .replace(TOKEN_PARAMETER, (_found, name: string, value: string) => `${name}${token(value)}`)
      .replace(EMAIL, 'user@example.com')
      .replace(PHONE, '555-555-0100')
      .replace(LONG_TOKEN, token);
    return out;
  };
  // A number under an id's key is the id too: the same placeholder, as a number.
  const redactNumber = (value: number): number | string => {
    const placeholder = replacements.get(String(value));
    if (placeholder === undefined) return value;
    return /^\d+$/.test(placeholder) ? Number(placeholder) : placeholder;
  };
  const redacted = recordings.map((recording) => redactFields(recording, redact, redactNumber));
  if (images.size > 0) report.image = images.size;
  return { recordings: redacted, report };
}

/**
 * What a redacted recording still holds that it must not, in words that repeat none of it: an
 * identity value that is not a placeholder, an email address, a JSON web token, or one of the
 * `identity` words. Empty when it is clean.
 */
export function unredacted(
  recording: unknown,
  identity: readonly string[] = [],
  keep: readonly string[] = [],
): string[] {
  const problems = new Set<string>();
  const kept = keep.map((text) => text.toLowerCase());
  for (const [term, { kind, key }] of collectTerms(recording)) {
    if (PLACEHOLDER.test(term) || kept.some((text) => text.includes(term.toLowerCase()))) continue;
    // The key, never the value: it says where to look without repeating what was found.
    const article = ['email', 'address', 'id'].includes(kind) ? 'an' : 'a';
    problems.add(`${article} ${kind} value under its key${key === null ? '' : ` (${key})`}`);
  }
  const words = identity.filter((word) => word.trim().length >= 3);
  const named =
    words.length === 0
      ? null
      : new RegExp(
          `(?<![A-Za-z0-9])(?:${words.map((word) => escapeRegExp(word.trim())).join('|')})(?![A-Za-z0-9])`,
          'i',
        );
  visitStrings(recording, (text) => {
    for (const email of text.match(EMAIL) ?? []) {
      if (!email.endsWith('@example.com')) problems.add('an email address');
    }
    if (new RegExp(JWT.source).test(text)) problems.add('a JSON web token');
    if (named?.test(text) === true) problems.add('a word that identifies the seller');
  });
  return [...problems];
}

/** Every identity value in the recording, with its kind. */
function collectTerms(value: unknown): Map<string, Term> {
  const terms = new Map<string, Term>();
  const walk = (node: unknown, key: string | null, parent: string | null): void => {
    if (typeof node === 'string') {
      if (key !== null) {
        const kind = kindOf(key, parent);
        if (kind !== null) addTerm(terms, node, kind, key);
      }
      for (const match of node.matchAll(KEYED_TEXT)) {
        const kind = kindOf(match[1] ?? '', null);
        const found = match[2] ?? match[3];
        if (kind !== null && found !== undefined) addTerm(terms, found, kind, match[1] ?? null);
      }
      for (const match of node.matchAll(KEYED_ATTRIBUTE)) {
        const name = (match[1] ?? '').toLowerCase();
        const found = match[2];
        if (found === undefined) continue;
        addTerm(terms, found, name === 'email' ? 'email' : 'user');
      }
      return;
    }
    if (typeof node === 'number') {
      if (key !== null && kindOf(key, parent) === 'id' && Number.isSafeInteger(node)) {
        addTerm(terms, String(node), 'id');
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key, parent);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [name, child] of Object.entries(node)) walk(child, name, key);
    }
  };
  walk(value, null, null);
  return terms;
}

function kindOf(key: string, parent: string | null): TermKind | null {
  for (const [pattern, kind] of IDENTITY_KEYS) {
    if (!pattern.test(key)) continue;
    // A capitalized key is a label's (Depop's translations: `"PostalCode": "Postal code"`), not
    // a person's data, which the sites key in lower case; a credential is one either way.
    return /^[A-Z]/.test(key) && kind !== 'secret' ? null : kind;
  }
  if (key === 'name' && parent !== null && PERSON_PARENT.test(parent)) return 'name';
  return null;
}

function addTerm(
  terms: Map<string, Term>,
  raw: string,
  kind: TermKind,
  key: string | null = null,
): void {
  const term = raw.trim();
  // A value that only names its own key (`"city": "City"`) is a label, not anyone's.
  const bare = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key !== null && bare(term) === bare(key)) return;
  const minimum = kind === 'secret' ? 8 : kind === 'id' ? 4 : 3;
  // A private part's text may be a whole paragraph (a profile's introduction).
  if (term.length < minimum || term.length > (kind === 'name' ? 2_000 : 200)) return;
  if (NOT_A_NAME.has(term.toLowerCase()) || PLACEHOLDER.test(term)) return;
  if (kind === 'address' && /^\d{1,3}$/.test(term)) return;
  if (!terms.has(term)) terms.set(term, { kind, key });
}

function placeholderFor(kind: TermKind, number: number, term: string): string {
  switch (kind) {
    case 'user':
      return `user${String(number)}`;
    case 'name':
      return `Name${String(number)}`;
    case 'email':
      return `user${String(number)}@example.com`;
    case 'phone':
      return `555-555-01${String(number % 100).padStart(2, '0')}`;
    case 'address':
      return 'Redacted';
    case 'id':
      // The same length and alphabet, so a page that checks an id's shape still accepts it.
      // A number keeps no leading zero: it may sit in JSON as a number.
      if (/^\d+$/.test(term))
        return `9${String(number).padStart(Math.max(term.length - 1, 1), '0')}`;
      return /^[0-9a-f]+$/i.test(term)
        ? String(number).padStart(term.length, '0')
        : `id${String(number)}`;
    case 'secret':
      return 'REDACTED';
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/**
 * The recording with `map` applied to every string a page, a script, or a marketplace wrote
 * (its own structure's keys and names stay as they are).
 */
function redactFields(
  recording: ExpandedRecording,
  map: (text: string) => string,
  mapNumber: (value: number) => number | string,
): ExpandedRecording {
  return {
    ...recording,
    input: mapStrings(recording.input, map, mapNumber),
    result: mapStrings(recording.result, map, mapNumber),
    steps: recording.steps.map(map),
    events: recording.events.map((event) => ({
      ...event,
      ...('url' in event ? { url: map(event.url) } : {}),
      ...('selector' in event ? { selector: map(event.selector) } : {}),
      ...('typed' in event ? { typed: map(event.typed) } : {}),
      ...('text' in event ? { text: map(event.text) } : {}),
      ...('value' in event ? { value: map(event.value) } : {}),
      ...('files' in event ? { files: event.files.map(map) } : {}),
    })),
    states: recording.states.map((state) => ({
      ...state,
      url: map(state.url),
      data: mapStrings(state.data, map, mapNumber),
      lines: state.lines.map(map),
    })),
    api: recording.api.map((answer) => ({
      ...answer,
      url: map(answer.url),
      ...(answer.json === undefined ? {} : { json: mapStrings(answer.json, map, mapNumber) }),
      ...(typeof answer.text === 'string' ? { text: map(answer.text) } : {}),
    })),
  };
}

/** The value with `map` applied to every string in it, object keys included (and numbers). */
function mapStrings<T>(
  value: T,
  map: (text: string) => string,
  mapNumber: (value: number) => number | string = (number) => number,
): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return map(node);
    if (typeof node === 'number') return mapNumber(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node).map(([key, child]) => [map(key), walk(child)]),
      );
    }
    return node;
  };
  return walk(value) as T;
}

function visitStrings(value: unknown, visit: (text: string) => void): void {
  mapStrings(value, (text) => {
    visit(text);
    return text;
  });
}
