/** SQLSTATE codes the API turns into contract errors. */
export const PG_ERROR = {
  foreignKeyViolation: '23503',
  uniqueViolation: '23505',
  checkViolation: '23514',
  deadlockDetected: '40P01',
} as const;

/** Whether `error` is a Postgres error with this SQLSTATE and, when given, constraint. */
export function isPgError(
  error: unknown,
  code: (typeof PG_ERROR)[keyof typeof PG_ERROR],
  constraint?: string,
): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code &&
    (constraint === undefined || ('constraint' in error && error.constraint === constraint))
  );
}
