/**
 * The data Depop's App Router pages are rendered from (the product page since 2025, every page
 * the seller's own session shows in 2026). These pages no longer embed `__NEXT_DATA__`
 * (page-data.ts): the server streams its React Server Components payload into inline scripts,
 * `self.__next_f.push([1, "<rows>"])`, and the rows hold the data the page's queries started
 * with (TanStack Query's dehydrated state, `{ queryKey, state: { data } }`).
 *
 * The scripts are read from the document rather than from `self.__next_f`, which keeps only the
 * chunks that arrived before Next.js took the array over. Reads look for a record by what it is
 * (a product with this slug) rather than by its place in the rows, which moves with the page's
 * layout; every record found is still checked against its schema.
 */
import type { PageDriver } from '../../runner/types.ts';

/** The page's inline scripts, where the payload's chunks are. */
const INLINE_SCRIPTS = 'script:not([src])';
const CHUNK_PREFIX = 'self.__next_f.push(';
/** A row: its hex id, an optional type tag, then its JSON (`6:[...]`, `a:I[...]`). */
const ROW = /^[0-9a-f]+:[A-Z]{0,2}(?=[[{"])/;
/** Bounds on the search through a page's rows, which are a few hundred kilobytes. */
const MAX_DEPTH = 48;
const MAX_NODES = 400_000;
const MAX_EMBEDDED = 2_000_000;

/** The JSON values of the page's payload rows, in order; empty for a page without one. */
export async function flightRows(page: PageDriver): Promise<unknown[]> {
  const stream = (await page.texts(INLINE_SCRIPTS))
    .flatMap((script) => {
      const chunk = flightChunk(script);
      return chunk === null ? [] : [chunk];
    })
    .join('');
  const rows: unknown[] = [];
  // A text row (`T<length>,`) may hold newlines; its lines are not JSON and are skipped.
  for (const line of stream.split('\n')) {
    const head = ROW.exec(line);
    if (head === null) continue;
    try {
      rows.push(JSON.parse(line.slice(head[0].length)) as unknown);
    } catch {
      // Not a JSON row.
    }
  }
  return rows;
}

/** One inline script's chunk of rows (`self.__next_f.push([1, "..."])`), else `null`. */
export function flightChunk(script: string): string | null {
  const text = script.trim();
  if (!text.startsWith(CHUNK_PREFIX) || !text.endsWith(')')) return null;
  try {
    const value: unknown = JSON.parse(text.slice(CHUNK_PREFIX.length, -1));
    return Array.isArray(value) && value[0] === 1 && typeof value[1] === 'string' ? value[1] : null;
  } catch {
    return null;
  }
}

/** A string that holds JSON (an object or an array), parsed; `undefined` for any other string. */
function embeddedJson(text: string): unknown {
  if (text.length < 2 || text.length > MAX_EMBEDDED || !/^[[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Every object in the rows that `matches` says is the one wanted, in the order found. */
export function findRecords(
  rows: readonly unknown[],
  matches: (record: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  let nodes = 0;
  const walk = (node: unknown, depth: number): void => {
    // Some pages pass a query's data on as a JSON string (the seller's own product page does).
    if (typeof node === 'string') {
      const embedded = embeddedJson(node);
      if (embedded !== undefined) walk(embedded, depth + 1);
      return;
    }
    if (node === null || typeof node !== 'object' || depth > MAX_DEPTH) return;
    nodes += 1;
    if (nodes > MAX_NODES) return;
    const values: unknown[] = Array.isArray(node) ? node : Object.values(node);
    if (!Array.isArray(node) && matches(node as Record<string, unknown>)) {
      found.push(node as Record<string, unknown>);
    }
    for (const value of values) walk(value, depth + 1);
  };
  for (const row of rows) walk(row, 0);
  return found;
}
