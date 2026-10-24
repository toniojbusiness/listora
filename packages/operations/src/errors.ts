import type { OperationStatus } from '@listora/db';

export class OperationNotFoundError extends Error {
  readonly operationId: string;

  constructor(operationId: string) {
    super(`Operation ${operationId} not found`);
    this.name = 'OperationNotFoundError';
    this.operationId = operationId;
  }
}

/** The state machine does not allow this change (for example canceling a running step). */
export class InvalidTransitionError extends Error {
  readonly operationId: string;
  readonly from: OperationStatus;
  readonly to: OperationStatus;

  constructor(operationId: string, from: OperationStatus, to: OperationStatus) {
    super(`Operation ${operationId} cannot go from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
    this.operationId = operationId;
    this.from = from;
    this.to = to;
  }
}

/** The operation changed after it was read; the change was not applied. */
export class ConcurrentOperationChangeError extends Error {
  readonly operationId: string;

  constructor(operationId: string) {
    super(`Operation ${operationId} was changed concurrently`);
    this.name = 'ConcurrentOperationChangeError';
    this.operationId = operationId;
  }
}

/** An idempotency key was reused for a different operation. */
export class IdempotencyConflictError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super('The idempotency key is already used by a different operation');
    this.name = 'IdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}

/** The operation's desired state is invalid for its kind. */
export class InvalidOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOperationError';
  }
}

/** A newer operation exists on the listing, so retrying this one would undo it. */
export class SupersededOperationError extends Error {
  readonly operationId: string;

  constructor(operationId: string) {
    super(`Operation ${operationId} was superseded by a newer operation on the same listing`);
    this.name = 'SupersededOperationError';
    this.operationId = operationId;
  }
}

/** Only a member of the operation's account can confirm it. */
export class NotAccountMemberError extends Error {
  constructor() {
    super('The user is not a member of the account');
    this.name = 'NotAccountMemberError';
  }
}
