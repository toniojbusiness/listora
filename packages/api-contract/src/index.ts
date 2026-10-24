// The Listora v1 API contract as TypeScript: request/response types for every operation
// (`paths`, `operations`), every schema (`components` plus root aliases such as `Item` and
// `Money`), and `as const` value arrays for every closed or `Known*` enum
// (`knownListingStatusValues`, ...).
// Generated from openapi.yaml; see README.md.
export * from './generated/openapi.ts';

/** Request header that makes a POST safe to retry; required on every POST (see openapi.yaml). */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
