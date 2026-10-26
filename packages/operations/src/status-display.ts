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

import { DEFAULT_RETRY_POLICY, maxAttempts } from './policy.ts';

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
  } | null;
  /** Now, for how long a step has waited for the phone (default: the clock). */
  now?: Date;
  /** Attempts an operation gets (default: the engine's default retry policy). */
  maxAttempts?: number;
}

/**
 * The error code of an operation Listora refused before sending anything to the marketplace: its
 * content breaks the marketplace's rules (eBay's standard size, a title too long). Retrying the
 * same content can only fail again, so it is not offered; the seller fixes the item or the
 * listing and sends it again, which a listing that never reached the marketplace allows.
 */
export const REFUSED_CONTENT_ERROR = 'validation_failed';

/** Whether a failed operation can be retried as it is (every failure but refused content). */
export function isRetryableFailure(errorCode: string | null | undefined): boolean {
  return errorCode !== REFUSED_CONTENT_ERROR;
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
} as const satisfies Record<OperationKind, string>;

/** "Delist failed - Retry". */
const FAILED = {
  create: 'Publish',
  revise: 'Update',
  price: 'Price change',
  end: 'Delist',
  relist: 'Relist',
  mark_sold: 'Mark sold',
  verify: 'Check',
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
    return describeSuccess(
      confirmedState(input.listingStatus),
      operation.successEvidence,
      operation.kind,
      name,
      input.listingStatus,
    );
  }
  return describeUnsettled(operation, name, input.maxAttempts, input.now);
}

/**
 * One operation as its history shows it. A success names what that operation did ("Delisted
 * (confirmed by eBay)"), never the listing's state now, which a later operation may have
 * changed.
 */
export function describeOperation(input: {
  marketplace: Marketplace;
  operation: OperationInput;
  maxAttempts?: number;
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
      return describeUnsettled(operation, name, input.maxAttempts, input.now);
    default:
      return assertNever(operation.status, 'operation status');
  }
}

/** An operation that is still running, waiting, or failed. */
function describeUnsettled(
  operation: OperationInput,
  name: string,
  attemptsPerOperation: number | undefined,
  now: Date | undefined,
): StatusDisplay {
  const detail = operation.errorMessage === null ? {} : { detail: operation.errorMessage };
  const { kind } = operation;
  const wait = operation.phoneWait;
  if (wait !== undefined && wait !== null && UNSETTLED_ON_PHONE.includes(operation.status)) {
    const doing = operation.status === 'verifying' ? 'Checking' : IN_PROGRESS[kind];
    if (wait.running) return { tone: 'in_progress', label: `${doing} on your iPhone...` };
    const waited = waitedFor((now ?? new Date()).getTime() - wait.since.getTime());
    return {
      tone: 'in_progress',
      label: `${doing}... waiting on your iPhone (${waited})`,
      detail: `Open Listora on your iPhone to finish this on ${name}. It has waited ${waited}.`,
    };
  }
  switch (operation.status) {
    case 'queued':
    case 'running':
      return { tone: 'in_progress', label: `${IN_PROGRESS[kind]}...` };
    case 'retrying': {
      const retries = (attemptsPerOperation ?? maxAttempts(DEFAULT_RETRY_POLICY)) - 1;
      const label = `${IN_PROGRESS[kind]}... retry ${String(operation.attempts)} of ${String(retries)}`;
      return { tone: 'in_progress', label, ...detail };
    }
    case 'verifying':
      return { tone: 'checking', label: 'Checking...', ...detail };
    case 'needs_user_action':
      return { tone: 'action_needed', label: `Action needed - ${USER_STEP[kind]} on ${name}` };
    case 'failed':
      return isRetryableFailure(operation.errorCode)
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

/** "less than a minute", "12 min", "3 h 5 min", "2 days". */
export function waitedFor(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${String(days)} days`;
}

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
