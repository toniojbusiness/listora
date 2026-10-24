import type { OperationKind } from '@listora/db';
import {
  desiredStateToJson,
  parseDesiredListingState,
  type DesiredListingState,
  type RemoteListingStatus,
} from '@listora/marketplaces';

import { InvalidOperationError } from './errors.ts';

/** The listing status a kind of operation leaves the listing in, when it sets one. */
const STATUS_FOR_KIND = {
  create: 'active',
  relist: 'active',
  end: 'ended',
  mark_sold: 'sold',
  revise: undefined,
  price: undefined,
  verify: undefined,
} as const satisfies Record<OperationKind, RemoteListingStatus | undefined>;

/**
 * Checks that a desired state can be verified for its kind of operation. It must name at least
 * one field, or any read-back would "confirm" it. Status-changing kinds must ask for exactly
 * their status; edits must not change the status.
 */
export function validateDesiredState(kind: OperationKind, value: unknown): DesiredListingState {
  let desired: DesiredListingState;
  try {
    desired = parseDesiredListingState(value);
  } catch (error) {
    throw new InvalidOperationError(error instanceof Error ? error.message : String(error));
  }
  if (Object.keys(desiredStateToJson(desired)).length === 0) {
    throw new InvalidOperationError('The desired state must name at least one field');
  }
  const status = STATUS_FOR_KIND[kind];
  if (status !== undefined && desired.status !== status) {
    throw new InvalidOperationError(`A ${kind} operation must set the status to ${status}`);
  }
  if (status === undefined && kind !== 'verify' && desired.status !== undefined) {
    throw new InvalidOperationError(`A ${kind} operation cannot change the status`);
  }
  if (kind === 'price' && desired.priceCents === undefined) {
    throw new InvalidOperationError('A price operation must set priceCents');
  }
  return desired;
}
