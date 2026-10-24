/**
 * Test-only helpers for this package's integration tests (not exported from the package).
 * The helpers other workspaces need are in testing.ts (`@listora/db/testing`).
 */
import { expect } from 'vitest';

export { createMigratedDatabase, insertAccount } from './testing.ts';
export type { MigratedDatabase } from './testing.ts';

/** Postgres SQLSTATE codes the constraint tests expect. */
export const PG_ERROR = {
  invalidTextRepresentation: '22P02',
  restrictViolation: '23001',
  notNullViolation: '23502',
  foreignKeyViolation: '23503',
  uniqueViolation: '23505',
  checkViolation: '23514',
} as const;

/** Asserts that `work` fails with the given SQLSTATE and, when given, constraint name. */
export async function expectPgError(
  work: PromiseLike<unknown>,
  code: (typeof PG_ERROR)[keyof typeof PG_ERROR],
  constraint?: string,
): Promise<void> {
  const error = await Promise.resolve(work).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error, 'expected the statement to fail').toBeDefined();
  expect(error).toMatchObject(constraint === undefined ? { code } : { code, constraint });
}
