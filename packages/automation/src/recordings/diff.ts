/**
 * What changed between a committed recording and a fresh one of the same entry
 * (docs/features/recorded-pages.md): the flag that a marketplace changed its page. It compares
 * what matters to a script, not every byte (prices, listings, and the site's generated class
 * names change all the time):
 *
 * - the result the script got on the real page,
 * - the actions it took there (the first one that differs),
 * - each page's structure: the kinds of element on it, by tag and the attributes scripts select
 *   by (`id`, `data-testid`, `role`, `name`, `type`), per page address with its ids generalized.
 */
import type { ExpandedRecording, RecordedEvent } from './recording.ts';

/** How many element kinds a change names before it counts the rest. */
const NAMED_KINDS = 8;

/** The changes, in words; empty when the page is as it was. */
export function recordingChanges(
  before: ExpandedRecording | undefined,
  after: ExpandedRecording,
): string[] {
  if (before === undefined) return ['a new recording'];
  const changes: string[] = [];
  if (JSON.stringify(before.result) !== JSON.stringify(after.result)) {
    changes.push(`the script's result changed: ${difference(before.result, after.result)}`);
  }
  const acted = firstDifferentEvent(before.events, after.events);
  if (acted !== null) changes.push(acted);
  const old = structure(before);
  const fresh = structure(after);
  for (const path of new Set([...old.keys(), ...fresh.keys()])) {
    const was = old.get(path);
    const now = fresh.get(path);
    if (was === undefined) {
      changes.push(`${path}: a page the script did not open before`);
      continue;
    }
    if (now === undefined) {
      changes.push(`${path}: a page the script no longer opens`);
      continue;
    }
    const gone = [...was].filter((kind) => !now.has(kind));
    const added = [...now].filter((kind) => !was.has(kind));
    if (gone.length > 0) changes.push(`${path}: no longer has ${named(gone)}`);
    if (added.length > 0) changes.push(`${path}: now has ${named(added)}`);
  }
  return changes;
}

function named(kinds: readonly string[]): string {
  const shown = kinds.slice(0, NAMED_KINDS).join(', ');
  return kinds.length > NAMED_KINDS
    ? `${shown}, and ${String(kinds.length - NAMED_KINDS)} more`
    : shown;
}

function firstDifferentEvent(
  before: readonly RecordedEvent[],
  after: readonly RecordedEvent[],
): string | null {
  const key = (event: RecordedEvent | undefined) => {
    if (event === undefined) return 'nothing';
    // Which state an action led to is the recording's numbering, not the page's.
    return JSON.stringify({ ...event, state: undefined });
  };
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    if (key(before[index]) !== key(after[index])) {
      return `the script's action ${String(index + 1)} changed: ${key(before[index])} became ${key(after[index])}`;
    }
  }
  return null;
}

/** The first place two JSON values differ, as a path. */
function difference(before: unknown, after: unknown, path = '$'): string {
  if (JSON.stringify(before) === JSON.stringify(after)) return path;
  if (
    before !== null &&
    after !== null &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    Array.isArray(before) === Array.isArray(after)
  ) {
    const a = before as Record<string, unknown>;
    const b = after as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
        return difference(a[key], b[key], `${path}.${key}`);
      }
    }
  }
  return `${path} was ${short(before)}, now ${short(after)}`;
}

function short(value: unknown): string {
  const text = value === undefined ? 'nothing' : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** The kinds of element on each page of the recording, by its generalized path. */
function structure(recording: ExpandedRecording): Map<string, Set<string>> {
  const pages = new Map<string, Set<string>>();
  for (const state of recording.states) {
    const path = generalPath(state.url);
    const kinds = pages.get(path) ?? new Set<string>();
    for (const kind of elementKinds(state.lines)) kinds.add(kind);
    pages.set(path, kinds);
  }
  return pages;
}

/** A page's path with what names one listing, user, or page of results generalized. */
export function generalPath(url: string): string {
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (parsed === null) return url;
  const segments = parsed.pathname
    .split('/')
    .map((segment) =>
      /\d/.test(segment) || /^user\d+/.test(segment) || segment.length > 24 ? '<id>' : segment,
    );
  return segments.join('/');
}

/** The kinds of element in a document as snapshot.ts writes it (`<tag attributes\n>`). */
export function elementKinds(lines: readonly string[]): Set<string> {
  const html = lines.join('\n').replace(/(<script\b[^>]*>)[\s\S]*?(<\/script)/g, '$1$2');
  const kinds = new Set<string>();
  for (const tag of html.matchAll(/<([a-z][a-z0-9-]*)([^<>]*)\n>/g)) {
    const attributes = new Map<string, string>();
    for (const attribute of (tag[2] ?? '').matchAll(/\s([^\s="]+)(?:="([^"]*)")?/g)) {
      attributes.set((attribute[1] ?? '').toLowerCase(), attribute[2] ?? '');
    }
    let kind = tag[1] ?? '';
    const id = attributes.get('id');
    // Generated ids (React's `:r1:`, numbered ones) name nothing a script could rely on.
    if (id !== undefined && id !== '' && !/[:\d]/.test(id)) kind += `#${id}`;
    for (const name of ['data-testid', 'role', 'name', 'type']) {
      const value = attributes.get(name);
      if (value !== undefined && value !== '' && !/\d{3}/.test(value))
        kind += `[${name}="${value}"]`;
    }
    if (kind !== tag[1]) kinds.add(kind);
  }
  return kinds;
}
