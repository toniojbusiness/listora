/**
 * The honest status vocabulary users see for a marketplace listing (docs/features/operations.md),
 * rendered on the server so no client ever infers success: `Active (confirmed by
 * eBay)`, `Delisting... retry 2 of 6`, `Delist failed - Retry`, `Checking...`, `Action needed -
 * delist on Poshmark`, `Done (you confirmed)`.
 *
 * Success comes only from the operation's evidence: "confirmed by <marketplace>" only for a
 * read-back, and "you confirmed" for the user's confirmation of an assisted step, never the
 * other way round. A listing without a successful operation is never shown as confirmed.
 */
import type {
  ListingStatus,
  Marketplace,
  OperationKind,
  OperationStatus,
  SuccessEvidence,
} from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { assertNever } from '@listora/shared';

/** How to style a status (the API contract's `KnownStatusTone`). */
export type StatusTone =
  'success' | 'in_progress' | 'checking' | 'failed' | 'action_needed' | 'neutral';

export interface StatusDisplay {
  tone: StatusTone;
  label: string;
  /** Extra context, for example the marketplace's error text. */
  detail?: string;
}

export interface ListingStatusInput {
  marketplace: Marketplace;
  /** `marketplace_listing.status`. */
  listingStatus: ListingStatus;
  /** The listing's newest operation, if any. */
  operation: {
    kind: OperationKind;
    status: OperationStatus;
    attempts: number;
    errorMessage: string | null;
    /** The failure's code; a failure the same content can never get past is not retryable. */
    errorCode?: string | null;
    successEvidence: SuccessEvidence | null;
    /**
     * Its step waits for the phone, or the phone runs it now (docs/features/phone-execution.md);
     * absent when its steps run in the cloud.
     */
    phoneWait?: PhoneWaitInput | null;
    /** When its next attempt is due (`next_attempt_at`); a retry waits until then. */
    nextAttemptAt?: Date | null;
  } | null;
  /** Now, for how long a step has waited for the phone (default: the clock). */
  now?: Date;
  /** What a relist of this listing does there (`relistMode`), for its in-progress label. */
  relist?: RelistMode | undefined;
}

/**
 * The error code of an operation Listora refused before sending anything to the marketplace: its
 * content breaks the marketplace's rules (eBay's standard size, a title too long). Retrying the
 * same content can only fail again, so it is not offered; the seller fixes the item or the
 * listing and sends it again, which a listing that never reached the marketplace allows.
 */
export const REFUSED_CONTENT_ERROR = 'validation_failed';

/** The operations that carry listing content (the schema's invariant), which a refusal is about. */
const CONTENT_KINDS: readonly OperationKind[] = ['create', 'revise', 'relist'];

/**
 * Whether a failed operation can be retried as it is: every failure but refused content. A
 * marketplace's own refusal shares the code, and only content can be fixed, so a refused delist,
 * price change, or check stays retryable: the marketplace may take it next time, and nothing
 * else can take the listing down.
 */
export function isRetryableFailure(
  errorCode: string | null | undefined,
  kind: OperationKind,
): boolean {
  return !(errorCode === REFUSED_CONTENT_ERROR && CONTENT_KINDS.includes(kind));
}

/** "Publishing...", while a step runs or waits. */
const IN_PROGRESS = {
  create: 'Publishing',
  revise: 'Updating',
  price: 'Updating price',
  end: 'Delisting',
  relist: 'Relisting',
  mark_sold: 'Marking sold',
  verify: 'Checking',
  refresh: 'Refreshing',
} as const satisfies Record<OperationKind, string>;

/**
 * What a relist does: brings back the listing Listora ended (`reactivate`: Mercari activates it,
 * Poshmark puts it back for sale) or posts a new listing (`new`: Depop, whose End deletes, and
 * any listing whose id a read-back cleared because the marketplace removed it, which the
 * executor sends as a create).
 */
export type RelistMode = 'reactivate' | 'new';

/** The marketplaces where a relist brings back the ended listing itself. */
const REACTIVATES: readonly Marketplace[] = ['mercari', 'poshmark'];

/**
 * How a relist goes for a listing on `marketplace`: `externalListingId` is its marketplace id
 * (`null` once a read-back confirmed the marketplace removed it), and `wasListed` says it was
 * listed before. `undefined` where Listora doesn't tell (eBay relists under a new id of its own,
 * and a first listing is no relist).
 */
export function relistMode(
  marketplace: Marketplace,
  externalListingId: string | null,
  wasListed: boolean,
): RelistMode | undefined {
  if (externalListingId === null) return wasListed ? 'new' : undefined;
  if (marketplace === 'depop') return 'new';
  return REACTIVATES.includes(marketplace) ? 'reactivate' : undefined;
}

/**
 * "Reactivating..." for a relist that brings the listing back, "Relisting (new listing)..." for
 * one that posts a new listing, else `IN_PROGRESS`.
 */
function inProgress(kind: OperationKind, relist: RelistMode | undefined): string {
  if (kind !== 'relist' || relist === undefined) return IN_PROGRESS[kind];
  return relist === 'reactivate' ? 'Reactivating' : 'Relisting (new listing)';
}

/** "Delist failed - Retry". */
const FAILED = {
  create: 'Publish',
  revise: 'Update',
  price: 'Price change',
  end: 'Delist',
  relist: 'Relist',
  mark_sold: 'Mark sold',
  verify: 'Check',
  refresh: 'Refresh',
} as const satisfies Record<OperationKind, string>;

/** "Action needed - delist on Poshmark". */
const USER_STEP = {
  create: 'list',
  revise: 'edit',
  price: 'change the price',
  end: 'delist',
  relist: 'relist',
  mark_sold: 'delist',
  verify: 'check',
  refresh: 'refresh',
} as const satisfies Record<OperationKind, string>;

/** "You delisted it on Poshmark." */
const USER_DONE = {
  create: 'listed it',
  revise: 'edited it',
  price: 'changed the price',
  end: 'delisted it',
  relist: 'relisted it',
  mark_sold: 'delisted it',
  verify: 'checked it',
  refresh: 'refreshed it',
} as const satisfies Record<OperationKind, string>;

/** "Delisted (confirmed by eBay)": what a succeeded operation made true, in its history. */
const RESULT = {
  create: 'Published',
  revise: 'Updated',
  price: 'Price changed',
  end: 'Delisted',
  relist: 'Relisted',
  mark_sold: 'Marked sold',
  verify: 'Checked',
  refresh: 'Refreshed',
} as const satisfies Record<OperationKind, string>;

type OperationInput = NonNullable<ListingStatusInput['operation']>;

/** A step handed to the phone (`phoneWaits` in phone-queue.ts). */
export interface PhoneWaitInput {
  since: Date;
  running: boolean;
}

export function describeListingStatus(input: ListingStatusInput): StatusDisplay {
  const { operation } = input;
  if (operation === null || operation.status === 'canceled') {
    return describeUnverified(input.listingStatus);
  }
  const name = MARKETPLACE_NAMES[input.marketplace];
  if (operation.status === 'succeeded') {
    // A listing Listora marked sold after a sale elsewhere did not sell there: "Marked sold".
    const state =
      operation.kind === 'mark_sold' && input.listingStatus === 'sold'
        ? RESULT.mark_sold
        : confirmedState(input.listingStatus);
    return describeSuccess(
      state,
      operation.successEvidence,
      operation.kind,
      name,
      input.listingStatus,
    );
  }
  return describeUnsettled(operation, name, input.now, input.relist);
}

/**
 * One operation as its history shows it. A success names what that operation did ("Delisted
 * (confirmed by eBay)"), never the listing's state now, which a later operation may have
 * changed.
 */
export function describeOperation(input: {
  marketplace: Marketplace;
  operation: OperationInput;
  now?: Date;
}): StatusDisplay {
  const { operation } = input;
  const name = MARKETPLACE_NAMES[input.marketplace];
  switch (operation.status) {
    case 'canceled':
      return { tone: 'neutral', label: 'Canceled' };
    case 'succeeded':
      return describeSuccess(
        RESULT[operation.kind],
        operation.successEvidence,
        operation.kind,
        name,
        null,
      );
    case 'queued':
    case 'running':
    case 'retrying':
    case 'verifying':
    case 'needs_user_action':
    case 'failed':
      return describeUnsettled(operation, name, input.now);
    default:
      return assertNever(operation.status, 'operation status');
  }
}

/** An operation that is still running, waiting, or failed. */
function describeUnsettled(
  operation: OperationInput,
  name: string,
  now: Date | undefined,
  relist?: RelistMode,
): StatusDisplay {
  const doingNow = inProgress(operation.kind, relist);
  const detail = operation.errorMessage === null ? {} : { detail: operation.errorMessage };
  const { kind } = operation;
  const wait = operation.phoneWait;
  const at = (now ?? new Date()).getTime();
  const due = operation.nextAttemptAt?.getTime() ?? null;
  // A retry before its time waits for that time, not for the phone, which takes it once it is
  // due.
  const retryLater = operation.status !== 'queued' && due !== null && due > at;
  if (
    wait !== undefined &&
    wait !== null &&
    UNSETTLED_ON_PHONE.includes(operation.status) &&
    (wait.running || !retryLater)
  ) {
    const doing = operation.status === 'verifying' ? 'Checking' : doingNow;
    if (wait.running) return { tone: 'in_progress', label: `${doing} on your iPhone...` };
    // What the seller can do, not how long the work has waited (that is the support views').
    return {
      tone: 'in_progress',
      label: `${doing}... open Listora on your iPhone`,
      detail: `Open Listora on your iPhone to finish this on ${name}.`,
    };
  }
  switch (operation.status) {
    case 'queued':
    case 'running':
      return { tone: 'in_progress', label: `${doingNow}...` };
    case 'retrying':
      // Listora is still on it; the attempt count and the last try's error are the support
      // views', not the seller's.
      return { tone: 'in_progress', label: `${doingNow}...` };
    case 'verifying':
      return { tone: 'checking', label: 'Checking...', ...detail };
    case 'needs_user_action':
      return { tone: 'action_needed', label: `Action needed - ${USER_STEP[kind]} on ${name}` };
    case 'failed':
      return isRetryableFailure(operation.errorCode, kind)
        ? { tone: 'failed', label: `${FAILED[kind]} failed - Retry`, ...detail }
        : { tone: 'failed', label: `${FAILED[kind]} failed`, ...detail };
    case 'succeeded':
    case 'canceled':
      throw new Error(`a ${operation.status} operation is settled`);
    default:
      return assertNever(operation.status, 'operation status');
  }
}

/** The statuses in which a step can wait for the phone. */
const UNSETTLED_ON_PHONE: readonly OperationStatus[] = ['queued', 'retrying', 'verifying'];

/**
 * `state` is what the read-back confirmed. Without evidence (which the database refuses) the
 * listing's recorded status is shown unconfirmed, or a neutral "Done" for an operation's history.
 */
function describeSuccess(
  state: string,
  evidence: SuccessEvidence | null,
  kind: OperationKind,
  name: string,
  listingStatus: ListingStatus | null,
): StatusDisplay {
  switch (evidence) {
    case 'read_back':
      return { tone: 'success', label: `${state} (confirmed by ${name})` };
    case 'user_confirmation':
      return {
        tone: 'success',
        label: 'Done (you confirmed)',
        detail: `You ${USER_DONE[kind]} on ${name}.`,
      };
    case null:
      // The database refuses a success without evidence; never show one as confirmed.
      return listingStatus === null
        ? { tone: 'neutral', label: 'Done' }
        : describeUnverified(listingStatus);
    default:
      return assertNever(evidence, 'success evidence');
  }
}

/** The state a read-back confirmed, as the listing row records it. */
function confirmedState(status: ListingStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'ended':
      return 'Delisted';
    case 'sold':
      return 'Sold';
    case 'draft':
    case 'queued':
    case 'publishing':
    case 'ending':
    case 'error':
    case 'unknown':
    case 'needs_user_action':
      return 'Done';
    default:
      return assertNever(status, 'listing status');
  }
}

/** A listing with no operation to speak for it: its recorded status, never "confirmed". */
function describeUnverified(status: ListingStatus): StatusDisplay {
  switch (status) {
    case 'draft':
      return { tone: 'neutral', label: 'Not listed' };
    case 'queued':
    case 'publishing':
      return { tone: 'in_progress', label: 'Publishing...' };
    case 'active':
      return { tone: 'neutral', label: 'Active' };
    case 'ending':
      return { tone: 'in_progress', label: 'Delisting...' };
    case 'ended':
      return { tone: 'neutral', label: 'Ended' };
    case 'sold':
      return { tone: 'neutral', label: 'Sold' };
    case 'error':
      return { tone: 'failed', label: 'Failed - Retry' };
    case 'unknown':
      return { tone: 'checking', label: 'Checking...' };
    case 'needs_user_action':
      return { tone: 'action_needed', label: 'Action needed' };
    default:
      return assertNever(status, 'listing status');
  }
}
