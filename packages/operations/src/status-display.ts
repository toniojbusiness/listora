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
    successEvidence: SuccessEvidence | null;
  } | null;
  /** Attempts an operation gets (default: the engine's default retry policy). */
  maxAttempts?: number;
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

export function describeListingStatus(input: ListingStatusInput): StatusDisplay {
  const name = MARKETPLACE_NAMES[input.marketplace];
  const { operation } = input;
  if (operation === null || operation.status === 'canceled') {
    return describeUnverified(input.listingStatus);
  }
  const detail = operation.errorMessage === null ? {} : { detail: operation.errorMessage };
  const { kind } = operation;
  switch (operation.status) {
    case 'queued':
    case 'running':
      return { tone: 'in_progress', label: `${IN_PROGRESS[kind]}...` };
    case 'retrying': {
      const retries = (input.maxAttempts ?? maxAttempts(DEFAULT_RETRY_POLICY)) - 1;
      const label = `${IN_PROGRESS[kind]}... retry ${String(operation.attempts)} of ${String(retries)}`;
      return { tone: 'in_progress', label, ...detail };
    }
    case 'verifying':
      return { tone: 'checking', label: 'Checking...', ...detail };
    case 'needs_user_action':
      return { tone: 'action_needed', label: `Action needed - ${USER_STEP[kind]} on ${name}` };
    case 'failed':
      return { tone: 'failed', label: `${FAILED[kind]} failed - Retry`, ...detail };
    case 'succeeded':
      return describeSuccess(input.listingStatus, operation.successEvidence, kind, name);
    default:
      return assertNever(operation.status, 'operation status');
  }
}

function describeSuccess(
  listingStatus: ListingStatus,
  evidence: SuccessEvidence | null,
  kind: OperationKind,
  name: string,
): StatusDisplay {
  switch (evidence) {
    case 'read_back':
      return { tone: 'success', label: `${confirmedState(listingStatus)} (confirmed by ${name})` };
    case 'user_confirmation':
      return {
        tone: 'success',
        label: 'Done (you confirmed)',
        detail: `You ${USER_DONE[kind]} on ${name}.`,
      };
    case null:
      // The database refuses a success without evidence; never show one as confirmed.
      return describeUnverified(listingStatus);
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
