/**
 * Success evidence: the only two ways an operation may become `succeeded` (docs/architecture.md
 * section 1, invariant 2). `transitionOperation` requires a `SuccessProof` to set `succeeded`, and
 * this module is the only place that creates one:
 *
 * - `confirmByReadBack` returns a proof only when the listing read back from the marketplace
 *   holds every field of the desired state **and** the read is current (`Freshness`), so a stale
 *   read that shows an older state which happens to match can never confirm a change;
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

/**
 * What makes a read-back current (docs/architecture.md section 6), by the adapter's
 * `readFreshness` capability.
 */
export type Freshness =
  /**
   * The read's revision must not be older than `newestSeen`, the newest revision Listora has
   * seen of this marketplace listing (from earlier reads and confirmed sends); `null` when it
   * has seen none.
   */
  | { kind: 'revision'; newestSeen: number | null }
  /**
   * No freshness marker: a matching read confirms only when the previous read of this
   * operation, a delay earlier and with no send in between, matched too.
   */
  | { kind: 'repeat'; previousReadMatched: boolean };

export type ReadBackResult =
  | { matches: true; proof: SuccessProof }
  | {
      matches: false;
      /**
       * `stale`: the read is older than a revision already seen, so it shows nothing about the
       * change. `unrepeated`: it matches, but without a freshness marker it must match again in
       * a later read.
       */
      reason: 'not_found' | 'mismatch' | 'nothing_desired' | 'stale' | 'unrepeated';
      fields: (keyof DesiredListingState)[];
    };

const COMPARED_FIELDS = ['status', 'title', 'description', 'priceCents', 'currency'] as const;

/**
 * Compares a read-back with the desired state; every desired field must match exactly, and the
 * read must be current. A stale read is reported as `stale` whether or not it matches, so it
 * never decides anything.
 */
export function confirmByReadBack(
  desired: DesiredListingState,
  remote: RemoteListingState,
  freshness: Freshness,
): ReadBackResult {
  // An empty desired state would match any listing, so it confirms nothing.
  if (!COMPARED_FIELDS.some((field) => desired[field] !== undefined)) {
    return { matches: false, reason: 'nothing_desired', fields: [] };
  }
  if (!remote.found) return { matches: false, reason: 'not_found', fields: [] };
  if (freshness.kind === 'revision' && !isCurrent(remote.revision, freshness.newestSeen)) {
    return { matches: false, reason: 'stale', fields: [] };
  }
  const fields = COMPARED_FIELDS.filter(
    (field) => desired[field] !== undefined && desired[field] !== remote[field],
  );
  if (fields.length > 0) return { matches: false, reason: 'mismatch', fields };
  if (freshness.kind === 'repeat' && !freshness.previousReadMatched) {
    return { matches: false, reason: 'unrepeated', fields: [] };
  }
  return {
    matches: true,
    proof: createProof('read_back', { evidence: 'read_back', remote: remoteSnapshot(remote) }),
  };
}

/** A read without a revision cannot show it is current. */
function isCurrent(revision: number | null, newestSeen: number | null): boolean {
  if (revision === null) return false;
  return newestSeen === null || revision >= newestSeen;
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
    revision: remote.revision,
  };
}
