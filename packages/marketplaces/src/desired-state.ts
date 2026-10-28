import type { JsonObject } from '@listora/db';
import type { CurrencyCode } from '@listora/shared';

import { REMOTE_LISTING_STATUSES, type DesiredListingState } from './adapter.ts';

const CURRENCIES: readonly CurrencyCode[] = ['USD'];
const FIELDS = [
  'status',
  'title',
  'description',
  'priceCents',
  'currency',
  'refreshedAfter',
] as const;

export class InvalidDesiredStateError extends Error {
  constructor(message: string) {
    super(`Invalid desired listing state: ${message}`);
    this.name = 'InvalidDesiredStateError';
  }
}

/**
 * Validates a desired listing state read from JSON (`marketplace_operation.desired`). Unknown
 * fields are an error, so a typo can never silently drop part of a change.
 */
export function parseDesiredListingState(value: unknown): DesiredListingState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidDesiredStateError('expected an object');
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !(FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new InvalidDesiredStateError(`unknown field ${unknown.join(', ')}`);

  const state: DesiredListingState = {};
  const { status, title, description, priceCents, currency, refreshedAfter } = record;
  if (status !== undefined) {
    const known = REMOTE_LISTING_STATUSES.find((candidate) => candidate === status);
    if (known === undefined) throw new InvalidDesiredStateError('status is not a listing status');
    state.status = known;
  }
  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim() === '') {
      throw new InvalidDesiredStateError('title must be a non-empty string');
    }
    state.title = title;
  }
  if (description !== undefined) {
    if (typeof description !== 'string') {
      throw new InvalidDesiredStateError('description must be a string');
    }
    state.description = description;
  }
  if (priceCents !== undefined) {
    if (typeof priceCents !== 'number' || !Number.isSafeInteger(priceCents) || priceCents < 0) {
      throw new InvalidDesiredStateError('priceCents must be a non-negative integer');
    }
    state.priceCents = priceCents;
  }
  if (currency !== undefined) {
    const known = CURRENCIES.find((candidate) => candidate === currency);
    if (known === undefined) throw new InvalidDesiredStateError('currency is not supported');
    state.currency = known;
  }
  if (refreshedAfter !== undefined) {
    if (typeof refreshedAfter !== 'string' || Number.isNaN(Date.parse(refreshedAfter))) {
      throw new InvalidDesiredStateError('refreshedAfter must be an ISO 8601 time');
    }
    state.refreshedAfter = refreshedAfter;
  }
  return state;
}

/** The JSON stored in `marketplace_operation.desired`, with absent fields left out. */
export function desiredStateToJson(state: DesiredListingState): JsonObject {
  const json: JsonObject = {};
  for (const field of FIELDS) {
    const value = state[field];
    if (value !== undefined) json[field] = value;
  }
  return json;
}
