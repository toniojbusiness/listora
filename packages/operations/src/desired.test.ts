import { describe, expect, it } from 'vitest';

import { validateDesiredState } from './desired.ts';
import { InvalidOperationError } from './errors.ts';

describe('validateDesiredState', () => {
  it.each([
    ['create', { status: 'active', title: 'Jacket', priceCents: 4500 }],
    ['relist', { status: 'active' }],
    ['end', { status: 'ended' }],
    ['mark_sold', { status: 'sold' }],
    ['price', { priceCents: 3900 }],
    ['revise', { title: 'Jacket, size M', description: 'Barely worn' }],
    ['verify', { status: 'active', priceCents: 3900 }],
  ] as const)('accepts a %s operation', (kind, desired) => {
    expect(validateDesiredState(kind, desired)).toEqual(desired);
  });

  it.each([
    ['create', {}, 'at least one field'],
    ['create', { title: 'Jacket' }, 'status to active'],
    ['end', { status: 'active' }, 'status to ended'],
    ['mark_sold', { status: 'ended' }, 'status to sold'],
    ['price', { title: 'Jacket' }, 'must set priceCents'],
    ['revise', { status: 'ended', title: 'Jacket' }, 'cannot change the status'],
    ['price', { priceCents: 12.5 }, 'non-negative integer'],
    ['price', { priceCents: 100, colour: 'red' }, 'unknown field colour'],
    ['revise', { title: '  ' }, 'non-empty string'],
    ['price', { priceCents: 100, currency: 'EUR' }, 'currency'],
  ] as const)('rejects a %s operation with %j', (kind, desired, message) => {
    expect(() => validateDesiredState(kind, desired)).toThrow(InvalidOperationError);
    expect(() => validateDesiredState(kind, desired)).toThrow(message);
  });
});
