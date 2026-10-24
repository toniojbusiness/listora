/**
 * Success evidence: the only two ways an operation may become `succeeded` (docs/architecture.md
 * section 1, invariant 2). `transitionOperation` requires a `SuccessProof` to set `succeeded`, and
 * this module is the only place that creates one:
 *
 * - `confirmByReadBack` returns a proof only when the listing read back from the marketplace
 *   holds every field of the desired state;
 * - `confirmByUser` records an explicit user confirmation of an assisted step.
 *
 * The brand is a module-private symbol, so no other module can build a proof without a cast.
 */
import type { JsonObject, SuccessEvidence } from '@listora/db';
import type { DesiredListingState, RemoteListingState } from '@listora/marketplaces';

declare const proofBrand: unique symbol;

export interface SuccessProof {
  readonly evidence: SuccessEvidence;
  /** Stored in the `succeeded` event: the remote state read back, or who confirmed. */
  readonly detail: JsonObject;
  readonly [proofBrand]: true;
}

export type ReadBackResult =
  | { matches: true; proof: SuccessProof }
  | {
      matches: false;
      reason: 'not_found' | 'mismatch' | 'nothing_desired';
      fields: (keyof DesiredListingState)[];
    };

const COMPARED_FIELDS = ['status', 'title', 'description', 'priceCents', 'currency'] as const;

/** Compares a read-back with the desired state; every desired field must match exactly. */
export function confirmByReadBack(
  desired: DesiredListingState,
  remote: RemoteListingState,
): ReadBackResult {
  // An empty desired state would match any listing, so it confirms nothing.
  if (!COMPARED_FIELDS.some((field) => desired[field] !== undefined)) {
    return { matches: false, reason: 'nothing_desired', fields: [] };
  }
  if (!remote.found) return { matches: false, reason: 'not_found', fields: [] };
  const fields = COMPARED_FIELDS.filter(
    (field) => desired[field] !== undefined && desired[field] !== remote[field],
  );
  if (fields.length > 0) return { matches: false, reason: 'mismatch', fields };
  return {
    matches: true,
    proof: createProof('read_back', { evidence: 'read_back', remote: remoteSnapshot(remote) }),
  };
}

/** Records that a user confirmed an assisted step themselves. */
export function confirmByUser(userId: string): SuccessProof {
  return createProof('user_confirmation', { evidence: 'user_confirmation', userId });
}

/** The only constructor of a proof; not exported. */
function createProof(evidence: SuccessEvidence, detail: JsonObject): SuccessProof {
  return { evidence, detail } as unknown as SuccessProof;
}

/** The normalized remote listing, as stored in `marketplace_listing.remote_snapshot`. */
export function remoteSnapshot(remote: Extract<RemoteListingState, { found: true }>): JsonObject {
  return {
    externalListingId: remote.externalListingId,
    externalUrl: remote.externalUrl,
    status: remote.status,
    title: remote.title,
    description: remote.description,
    priceCents: remote.priceCents,
    currency: remote.currency,
  };
}
