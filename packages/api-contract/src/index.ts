// The Listora v1 API contract as TypeScript: request/response types for every operation
// (`paths`, `operations`), every schema (`components` plus root aliases such as `Item` and
// `Money`), and `as const` value arrays for every closed or `Known*` enum
// (`knownListingStatusValues`, ...).
// Generated from openapi.yaml; see README.md.
export * from './generated/openapi.ts';
// The parsed contract document, for building request validators from the contract itself.
export {
  CONTRACT_BUNDLE_PATH,
  CONTRACT_METHODS,
  CONTRACT_SPEC_PATH,
  loadContractDocument,
} from './document.ts';
export type {
  ContractDocument,
  ContractMethod,
  ContractOperation,
  ContractParameter,
  ContractPathItem,
  ContractRequestBody,
  ContractResponse,
  ContractSchema,
} from './document.ts';
export { openEnumKnownRef } from './open-enum.ts';

/** Request header that makes a POST safe to retry; required on every POST (see openapi.yaml). */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
