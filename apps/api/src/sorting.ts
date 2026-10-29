/**
 * Sorted lists with keyset pagination (docs/features/sorting.md). A list's order is a few
 * non-null SQL terms ending with the row's id, so every row has one place and ties never move
 * between pages. The page's cursor carries the last row's value of each term and the sort it was
 * issued for.
 */
import { sql, type RawBuilder, type SelectQueryBuilder } from 'kysely';

import { ApiError } from './errors.ts';

/** How a term's value is carried in a cursor and compared in SQL. */
export type SortTermType = 'boolean' | 'bigint' | 'text' | 'uuid';

/** One term of an order. */
export interface SortTerm {
  /**
   * Never null: a nullable column becomes two terms, an `is null` flag (ascending, so rows
   * without a value come last) and the coalesced value.
   */
  value: RawBuilder<unknown>;
  direction: 'asc' | 'desc';
  type: SortTermType;
}

/** A term's value in a cursor, as `jsonb_build_array` returns it. */
export type SortValue = boolean | number | string;

/** Where a sorted page ended: the last row's value of each term. */
export interface SortCursor {
  values: readonly SortValue[];
}

const SORT_CURSOR_VERSION = 's1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A text term is a title at most; anything longer was not issued by this server. */
const MAX_TEXT_VALUE = 2000;

/** Opaque cursor for the page after the row whose terms are `values`, under `sort`. */
export function encodeSortCursor(sort: string, values: readonly SortValue[]): string {
  return Buffer.from(`${SORT_CURSOR_VERSION}:${sort}:${JSON.stringify(values)}`).toString(
    'base64url',
  );
}

/**
 * The values a cursor continues after; `400 invalid_request` for a cursor this server did not
 * issue, or one issued for another sort (its values mean nothing in this order).
 */
export function decodeSortCursor(
  cursor: string,
  sort: string,
  terms: readonly SortTerm[],
): SortCursor {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const prefix = `${SORT_CURSOR_VERSION}:${sort}:`;
  let values: unknown;
  try {
    values = text.startsWith(prefix) ? JSON.parse(text.slice(prefix.length)) : undefined;
  } catch {
    values = undefined;
  }
  if (
    !Array.isArray(values) ||
    values.length !== terms.length ||
    !terms.every((term, index) => isValueOf(term.type, values[index]))
  ) {
    throw new ApiError(
      'invalid_request',
      'The page cursor is not valid for this order. Start from the first page.',
    );
  }
  return { values: values as SortValue[] };
}

function isValueOf(type: SortTermType, value: unknown): boolean {
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'bigint':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'text':
      return typeof value === 'string' && value.length <= MAX_TEXT_VALUE;
    case 'uuid':
      return typeof value === 'string' && UUID.test(value);
  }
}

/**
 * Orders `query` by `terms`, continues after `after` when given, and selects the row's terms as
 * `sort_key` for the next page's cursor.
 */
export function sortedRows<DB, TB extends keyof DB, O>(
  query: SelectQueryBuilder<DB, TB, O>,
  terms: readonly SortTerm[],
  after: SortCursor | undefined,
): SelectQueryBuilder<DB, TB, O & { sort_key: SortValue[] }> {
  let sorted = query
    .select(
      sql<SortValue[]>`jsonb_build_array(${sql.join(terms.map((term) => term.value))})`.as(
        'sort_key',
      ),
    )
    .$castTo<O & { sort_key: SortValue[] }>();
  if (after !== undefined) sorted = sorted.where(afterCondition(terms, after.values));
  for (const term of terms) sorted = sorted.orderBy(term.value, term.direction);
  return sorted;
}

/**
 * Rows after the cursor's: equal on every earlier term and past it on one, for terms in mixed
 * directions (a row comparison only handles one direction).
 */
function afterCondition(
  terms: readonly SortTerm[],
  values: readonly SortValue[],
): RawBuilder<boolean> {
  const param = (index: number) => {
    const term = terms[index];
    if (term === undefined) throw new Error(`no sort term ${String(index)}`);
    return sql`cast(${values[index]} as ${sql.raw(term.type)})`;
  };
  const branches = terms.map((term, index) => {
    const equal = terms.slice(0, index).map((earlier, j) => sql`${earlier.value} = ${param(j)}`);
    const past =
      term.direction === 'asc'
        ? sql`${term.value} > ${param(index)}`
        : sql`${term.value} < ${param(index)}`;
    return sql`(${sql.join([...equal, past], sql` and `)})`;
  });
  return sql<boolean>`(${sql.join(branches, sql` or `)})`;
}

/**
 * A timestamp as a sort value: microseconds since the epoch, Postgres's own precision, so rows
 * written a moment apart keep their order (and stay below `Number.MAX_SAFE_INTEGER` until 2255).
 */
export function epochMicroseconds(timestamp: RawBuilder<unknown>): RawBuilder<number> {
  return sql<number>`floor(extract(epoch from ${timestamp}) * 1000000)::bigint`;
}
