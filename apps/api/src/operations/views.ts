import type {
  Operation,
  OperationError,
  OperationEvent,
  Verification,
} from '@listora/api-contract';
import { operationEventError, operationEventMessage } from '@listora/activity';
import type { JsonObject, Marketplace, OperationKind, OperationStatus } from '@listora/db';
import {
  DEFAULT_RETRY_POLICY,
  describeOperation,
  isRetryableFailure,
  maxAttemptsFor,
  SETTLED_STATUSES,
  type PhoneWait,
} from '@listora/operations';

import type { OperationRow } from '../listings/repository.ts';

/** Attempts the worker gives an operation (its policy keeps the count whatever its delays). */

/** The listing columns an operation's view needs. */
export interface OperationListing {
  item_id: string;
  marketplace: Marketplace;
}

/**
 * An operation's error as the contract shows it. Only a failed operation can be retried, and not
 * one whose content Listora refused before sending it: the same content would fail again.
 */
function operationError(
  status: OperationStatus,
  kind: OperationKind,
  code: string | null,
  message: string | null,
): OperationError | undefined {
  if (code === null) return undefined;
  return {
    code,
    message: message ?? 'Something went wrong.',
    retryable: status === 'failed' && isRetryableFailure(code, kind),
  };
}

/** How a succeeded operation was established: a read-back, or the user's confirmation. */
function operationVerification(op: OperationRow): Verification | undefined {
  if (op.status !== 'succeeded' || op.success_evidence === null) return undefined;
  return {
    method: op.success_evidence === 'read_back' ? 'marketplace_api' : 'user_confirmation',
    verifiedAt: op.updated_at.toISOString(),
  };
}

/** The contract's `Operation`, with the label of what it did or is doing. */
export function operationView(
  op: OperationRow,
  listing: OperationListing,
  /** Its step waits for the seller's iPhone, or the phone runs it now (phone-execution.md). */
  phoneWait?: PhoneWait | null,
): Operation {
  const error = operationError(op.status, op.kind, op.error_code, op.error_message);
  const verification = operationVerification(op);
  const settled = (SETTLED_STATUSES as readonly string[]).includes(op.status);
  return {
    id: op.id,
    listingId: op.listing_id,
    itemId: listing.item_id,
    marketplace: listing.marketplace,
    kind: op.kind,
    status: op.status,
    statusDisplay: describeOperation({
      marketplace: listing.marketplace,
      operation: {
        kind: op.kind,
        status: op.status,
        attempts: op.attempts,
        errorMessage: op.error_message,
        errorCode: op.error_code,
        successEvidence: op.success_evidence,
        phoneWait: phoneWait ?? null,
        nextAttemptAt: op.next_attempt_at,
      },
    }),
    attempt: op.attempts,
    maxAttempts: maxAttemptsFor(DEFAULT_RETRY_POLICY, op.kind),
    ...(op.next_attempt_at === null ? {} : { nextAttemptAt: op.next_attempt_at.toISOString() }),
    origin: {
      type: op.origin,
      ...(op.price_drop_rule_id === null ? {} : { repriceRuleId: op.price_drop_rule_id }),
    },
    ...(error === undefined ? {} : { error }),
    ...(verification === undefined ? {} : { verification }),
    createdAt: op.created_at.toISOString(),
    updatedAt: op.updated_at.toISOString(),
    ...(settled ? { completedAt: op.updated_at.toISOString() } : {}),
  };
}

export interface EventRow {
  id: string;
  operation_id: string;
  sequence: number;
  from_status: OperationStatus | null;
  to_status: OperationStatus;
  attempt: number;
  error_code: string | null;
  detail: JsonObject;
  created_at: Date;
}

/** The contract's `OperationEvent`; its detail is already redacted for storage. */
export function eventView(
  event: EventRow,
  operation: { marketplace: Marketplace; kind: OperationKind },
): OperationEvent {
  const message = operationEventMessage(event, operation.marketplace).slice(0, 1000);
  const error = operationError(
    event.to_status,
    operation.kind,
    event.error_code,
    operationEventError(event.detail),
  );
  return {
    id: event.id,
    operationId: event.operation_id,
    sequence: event.sequence,
    ...(event.from_status === null ? {} : { fromStatus: event.from_status }),
    toStatus: event.to_status,
    attempt: event.attempt,
    message,
    ...(error === undefined ? {} : { error }),
    detail: event.detail,
    occurredAt: event.created_at.toISOString(),
  };
}
