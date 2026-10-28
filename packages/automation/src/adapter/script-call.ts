/**
 * One run of an automation script, as plain data: which marketplace's scripts, on which site,
 * which script, and its input. The automation adapter base describes every session it asks for
 * this way, so another host can run exactly the same script: the browser runner runs it in
 * Playwright, and the iPhone app runs it in its own web view (docs/features/phone-execution.md),
 * from the same script definitions (`<marketplace>/scripts.ts`) bundled for the phone.
 *
 * Everything here is JSON-safe (a time is an ISO string), because a call to the phone crosses
 * the API, and the module imports no runtime code beyond the scripts' own types, so the phone's
 * bundle can include it.
 */
import type {
  AssistedListingPayload,
  AutomatedMarketplace,
  LabelReadRequest,
  ListingRef,
  OfferAnswerRequest,
  OfferRef,
  RemoteOffer,
  RemoteOfferState,
  OperationRequest,
  ListingsPage,
  RemoteListingState,
  RemoteOrder,
  RemoteOrderLabel,
} from '@listora/marketplaces';

import { assertNever } from '@listora/shared';

import type { StepRunner } from '../runner/types.ts';

/** What a write script reports when it ran to its end. */
export type WriteResult =
  /** The marketplace took the change; the engine still reads it back to verify. */
  | { type: 'applied'; externalListingId?: string; revision?: number }
  /** The marketplace refused it (a validation message on its form): retrying cannot help. */
  | { type: 'rejected'; code: string; message: string; fixHint?: string };

/** What an offer answer's script reports when it ran to its end (docs/features/offers.md). */
export type OfferAnswerResult =
  /** The marketplace took the answer; a read of the offer still has to show it. */
  | { type: 'applied' }
  /** The marketplace refused it (the offer moved on, a counter out of its range). */
  | { type: 'refused'; code: string; message: string };

export type WriteScript<P extends AssistedListingPayload> = (
  op: OperationRequest<P>,
  step: StepRunner,
) => Promise<WriteResult>;

export interface AutomationScripts<P extends AssistedListingPayload> {
  create?: WriteScript<P>;
  revise?: WriteScript<P>;
  price?: WriteScript<P>;
  end?: WriteScript<P>;
  relist?: WriteScript<P>;
  markSold?: WriteScript<P>;
  /**
   * Reads the listing (by its id, else by the seller's SKU). Must say `authoritative` only for
   * the marketplace's own "removed" answer for that id. Only reads: no step may mutate.
   */
  read: (ref: ListingRef, step: StepRunner) => Promise<RemoteListingState>;
  /** Opens a page only a logged-in seller sees, to show the session works. Only reads. */
  health: (step: StepRunner) => Promise<void>;
  /** The seller's orders sold at or after `since`, for sale checks. Only reads. */
  orders?: (since: Date | null, step: StepRunner) => Promise<RemoteOrder[]>;
  /**
   * One page of the seller's listings for sale, with what an import needs: the first for a
   * `null` cursor, else the page the cursor a page returned names. Only reads.
   */
  listings?: (cursor: string | null, step: StepRunner) => Promise<ListingsPage>;
  /** The orders' shipping labels from their order pages, for Pack check. Only reads. */
  labels?: (orders: readonly LabelReadRequest[], step: StepRunner) => Promise<RemoteOrderLabel[]>;
  /** The offers on the seller's listings that wait on the seller or the buyer. Only reads. */
  offers?: (step: StepRunner) => Promise<RemoteOffer[]>;
  /** One offer as its page shows it now. Only reads. */
  offer?: (ref: OfferRef, step: StepRunner) => Promise<RemoteOfferState>;
  /**
   * Sends the seller's answer to an offer: only its last step mutates, and it stops (a
   * `PageChangedError`) when the offer shows another amount than the seller confirmed.
   */
  answerOffer?: (request: OfferAnswerRequest, step: StepRunner) => Promise<OfferAnswerResult>;
}

/** The script sets: one per automation adapter (the fake site's stands in for any marketplace). */
export const SCRIPT_SETS = ['poshmark', 'mercari', 'depop', 'ebay', 'fake_site'] as const;
export type ScriptSetName = (typeof SCRIPT_SETS)[number];

/** Whose scripts a call runs, and the site they drive. */
export interface ScriptSet {
  name: ScriptSetName;
  marketplace: AutomatedMarketplace;
  /** The marketplace's own site, or its stand-in in development and tests. */
  siteUrl: string;
}

export const WRITE_SCRIPTS = ['create', 'revise', 'price', 'end', 'relist', 'markSold'] as const;
export type WriteScriptName = (typeof WRITE_SCRIPTS)[number];

/** Which script runs, with its input. */
export type ScriptCall<P extends AssistedListingPayload = AssistedListingPayload> =
  | { script: WriteScriptName; op: OperationRequest<P> }
  | { script: 'read'; ref: ListingRef }
  | { script: 'health' }
  /** `since` is an ISO time, or `null` for every order the pages show. */
  | { script: 'orders'; since: string | null }
  /** `cursor`: `null` for the first page, else the `next` of the page before. */
  | { script: 'listings'; cursor: string | null }
  | { script: 'labels'; orders: LabelReadRequest[] }
  | { script: 'offers' }
  | { script: 'offer'; ref: OfferRef }
  | { script: 'answerOffer'; request: OfferAnswerRequest };

/**
 * Whether an earlier attempt of the operation may have posted or changed the listing, so a
 * create or relist looks for that listing before it posts (`OperationRequest.mayHaveApplied`;
 * a request that doesn't say counts every attempt after the first).
 */
export function mayHaveAppliedBefore(
  op: Pick<OperationRequest<AssistedListingPayload>, 'attempt' | 'mayHaveApplied'>,
): boolean {
  return op.mayHaveApplied ?? op.attempt > 1;
}

/** Whether the call may change anything: only a write script's may. */
export function isWriteCall(call: ScriptCall): boolean {
  return (
    call.script === 'answerOffer' || (WRITE_SCRIPTS as readonly string[]).includes(call.script)
  );
}

/** Runs the call's script from `scripts`; throws when the set has no such script. */
export async function runScriptCall<P extends AssistedListingPayload>(
  scripts: AutomationScripts<P>,
  call: ScriptCall<P>,
  step: StepRunner,
): Promise<unknown> {
  switch (call.script) {
    case 'create':
    case 'revise':
    case 'price':
    case 'end':
    case 'relist':
    case 'markSold': {
      const script = scripts[call.script];
      if (script === undefined) throw new Error(`these scripts have no ${call.script} script`);
      return script(call.op, step);
    }
    case 'read':
      return scripts.read(call.ref, step);
    case 'health':
      return scripts.health(step);
    case 'orders': {
      const orders = scripts.orders;
      if (orders === undefined) throw new Error('these scripts read no orders');
      return orders(call.since === null ? null : new Date(call.since), step);
    }
    case 'listings': {
      const listings = scripts.listings;
      if (listings === undefined) throw new Error('these scripts list no listings');
      return listings(call.cursor, step);
    }
    case 'labels': {
      const labels = scripts.labels;
      if (labels === undefined) throw new Error('these scripts read no order labels');
      return labels(call.orders, step);
    }
    case 'offers': {
      const offers = scripts.offers;
      if (offers === undefined) throw new Error('these scripts read no offers');
      return offers(step);
    }
    case 'offer': {
      const offer = scripts.offer;
      if (offer === undefined) throw new Error('these scripts read no offers');
      return offer(call.ref, step);
    }
    case 'answerOffer': {
      const answer = scripts.answerOffer;
      if (answer === undefined) throw new Error('these scripts answer no offers');
      return answer(call.request, step);
    }
    default:
      return assertNever(call, 'script call');
  }
}
