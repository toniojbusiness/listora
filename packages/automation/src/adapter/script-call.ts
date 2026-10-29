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
   * Refreshes a live listing in place through the marketplace's own normal mechanism (a share,
   * an edit saved unchanged), never a delete and repost (docs/features/listing-refresh.md).
   * The read script must then show the time of it (`refreshedAt`).
   */
  refresh?: WriteScript<P>;
  /**
   * Reads the listing (by its id, else by the seller's SKU). Must say `authoritative` only for
   * the marketplace's own "removed" answer for that id. Only reads: no step may mutate.
   */
  read: (ref: ListingRef, step: StepRunner) => Promise<RemoteListingState>;
  /**
   * Opens a page only a logged-in seller sees, to show the session works, and returns the
   * seller it is signed in as (`sellerIdentity` of the page's handle), or `null` when the page
   * doesn't show one Listora can read. Only reads.
   */
  health: (step: StepRunner) => Promise<string | null>;
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

export const WRITE_SCRIPTS = [
  'create',
  'revise',
  'price',
  'end',
  'relist',
  'markSold',
  'refresh',
] as const;
export type WriteScriptName = (typeof WRITE_SCRIPTS)[number];

/**
 * The seller a write must find signed in (the connection's recorded shop): before its first
 * step, the call reads the signed-in seller with the health script and changes nothing when it
 * is another one (docs/features/marketplace-linking.md#the-shop-a-connection-holds). Absent while
 * Listora doesn't know the connection's seller; a runtime older than it ignores it.
 */
interface ExpectedSeller {
  expectedSeller?: string;
}

/** Which script runs, with its input. */
export type ScriptCall<P extends AssistedListingPayload = AssistedListingPayload> =
  | ({ script: WriteScriptName; op: OperationRequest<P> } & ExpectedSeller)
  | { script: 'read'; ref: ListingRef }
  | { script: 'health' }
  /** `since` is an ISO time, or `null` for every order the pages show. */
  | { script: 'orders'; since: string | null }
  /** `cursor`: `null` for the first page, else the `next` of the page before. */
  | { script: 'listings'; cursor: string | null }
  | { script: 'labels'; orders: LabelReadRequest[] }
  | { script: 'offers' }
  | { script: 'offer'; ref: OfferRef }
  | ({ script: 'answerOffer'; request: OfferAnswerRequest } & ExpectedSeller);

/** The longest seller id Listora keeps (`marketplace_connection.external_user_id`). */
const MAX_SELLER_ID = 255;

/**
 * A seller's handle as a page shows it, as the id Listora compares and records: trimmed and
 * lower-cased (marketplaces treat handles without case), or `null` when there is none to use.
 */
export function sellerIdentity(handle: string | null | undefined): string | null {
  const id = handle?.trim().toLowerCase() ?? '';
  return id.length === 0 || id.length > MAX_SELLER_ID ? null : id;
}

/** The code of a change refused because another seller is signed in than the connection's. */
export const SELLER_MISMATCH = 'seller_mismatch';

/** What the seller reads when a change was refused because another shop is signed in. */
export const SELLER_MISMATCH_MESSAGE =
  'Listora is signed in to another shop than the one linked, so it changed nothing. Link the shop again in Link accounts, then try again.';

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

export type ScriptName = ScriptCall['script'];

/**
 * Every script, as a read or a write. The type makes a new script choose before it compiles; at
 * run time only the ones named `read` count as reads, so anything else (a script name from a
 * newer server or phone, or a mistake) is a write, and a read-only connection refuses it
 * (docs/features/read-only.md).
 */
const SCRIPT_ACCESS = {
  create: 'write',
  revise: 'write',
  price: 'write',
  end: 'write',
  relist: 'write',
  markSold: 'write',
  refresh: 'write',
  answerOffer: 'write',
  read: 'read',
  health: 'read',
  orders: 'read',
  listings: 'read',
  labels: 'read',
  offers: 'read',
  offer: 'read',
} as const satisfies Record<ScriptName, 'read' | 'write'>;

/** The scripts that only read: the only ones a read-only connection runs. */
export const READ_SCRIPTS: readonly ScriptName[] = Object.entries(SCRIPT_ACCESS)
  .filter(([, access]) => access === 'read')
  .map(([script]) => script as ScriptName);

/** Whether the call may change anything: every script but the named reads may. */
export function isWriteCall(call: Pick<ScriptCall, 'script'>): boolean {
  return !(READ_SCRIPTS as readonly string[]).includes(call.script);
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
    case 'markSold':
    case 'refresh': {
      const script = scripts[call.script];
      if (script === undefined) throw new Error(`these scripts have no ${call.script} script`);
      if (await signedInAsAnother(scripts, call, step)) {
        return { type: 'rejected', code: SELLER_MISMATCH, message: SELLER_MISMATCH_MESSAGE };
      }
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
      if (await signedInAsAnother(scripts, call, step)) {
        return { type: 'refused', code: SELLER_MISMATCH, message: SELLER_MISMATCH_MESSAGE };
      }
      return answer(call.request, step);
    }
    default:
      return assertNever(call, 'script call');
  }
}

/**
 * Whether the session is signed in as another seller than the call expects, read by the health
 * script before anything changes. A page that doesn't show the seller is not proof of another
 * one: the call goes ahead, as it did before Listora knew sellers.
 */
async function signedInAsAnother<P extends AssistedListingPayload>(
  scripts: AutomationScripts<P>,
  call: ExpectedSeller,
  step: StepRunner,
): Promise<boolean> {
  if (call.expectedSeller === undefined) return false;
  const seen = await scripts.health(step);
  return seen !== null && seen !== call.expectedSeller;
}
