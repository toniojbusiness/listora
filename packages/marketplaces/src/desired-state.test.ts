import { describe, expect, it } from 'vitest';

import {
  desiredStateToJson,
  InvalidDesiredStateError,
  parseDesiredListingState,
} from './desired-state.ts';

describe('desired listing state', () => {
  it('round-trips through JSON in a canonical field order', () => {
    const state = parseDesiredListingState({
      priceCents: 4500,
      title: 'Jacket',
      status: 'active',
      currency: 'USD',
      description: '',
    });
    expect(Object.keys(desiredStateToJson(state))).toEqual([
      'status',
      'title',
      'description',
      'priceCents',
      'currency',
    ]);
    expect(parseDesiredListingState(desiredStateToJson(state))).toEqual(state);
  });

  it('leaves absent fields out', () => {
    expect(desiredStateToJson({ priceCents: 100 })).toEqual({ priceCents: 100 });
  });

  it.each([
    [null, 'expected an object'],
    [[], 'expected an object'],
    [{ status: 'deleted' }, 'status'],
    [{ title: '' }, 'title'],
    [{ title: 7 }, 'title'],
    [{ description: 7 }, 'description'],
    [{ priceCents: -1 }, 'priceCents'],
    [{ priceCents: '100' }, 'priceCents'],
    [{ priceCents: Number.MAX_SAFE_INTEGER + 1 }, 'priceCents'],
    [{ currency: 'GBP' }, 'currency'],
    [{ price: 100 }, 'unknown field price'],
  ])('rejects %j', (value, message) => {
    expect(() => parseDesiredListingState(value)).toThrow(InvalidDesiredStateError);
    expect(() => parseDesiredListingState(value)).toThrow(message);
  });
});
