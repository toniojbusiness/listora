import { describe, expect, it } from 'vitest';

import type { RemoteListingState } from '@listora/marketplaces';

import { confirmByReadBack, confirmByUser, type Freshness } from './evidence.ts';

/** A current read: nothing newer was seen before. */
const CURRENT: Freshness = { kind: 'revision', newestSeen: 7 };

const remote: RemoteListingState = {
  found: true,
  externalListingId: 'EBAY-1',
  externalUrl: 'https://example.invalid/EBAY-1',
  status: 'active',
  title: 'Denim jacket',
  description: 'Size M',
  priceCents: 4500,
  currency: 'USD',
  revision: 7,
};

describe('confirmByReadBack', () => {
  it('returns a read-back proof only when every desired field matches', () => {
    const result = confirmByReadBack({ status: 'active', priceCents: 4500 }, remote, CURRENT);
    expect(result).toMatchObject({
      matches: true,
      proof: {
        evidence: 'read_back',
        detail: {
          evidence: 'read_back',
          remote: { externalListingId: 'EBAY-1', priceCents: 4500, revision: 7 },
        },
      },
    });
  });

  it('names the fields that do not match', () => {
    expect(confirmByReadBack({ priceCents: 3900, title: 'Denim jacket' }, remote, CURRENT)).toEqual(
      {
        matches: false,
        reason: 'mismatch',
        fields: ['priceCents'],
      },
    );
    expect(
      confirmByReadBack({ status: 'ended' }, { ...remote, status: 'sold' }, CURRENT),
    ).toMatchObject({
      matches: false,
      fields: ['status'],
    });
  });

  it('never confirms a listing that was not found', () => {
    expect(confirmByReadBack({ status: 'ended' }, { found: false }, CURRENT)).toEqual({
      matches: false,
      reason: 'not_found',
      fields: [],
    });
  });

  it('never confirms an empty desired state', () => {
    expect(confirmByReadBack({}, remote, CURRENT)).toEqual({
      matches: false,
      reason: 'nothing_desired',
      fields: [],
    });
  });

  it('never confirms a read older than a revision already seen, even when it matches', () => {
    const stale = { kind: 'revision', newestSeen: 8 } as const;
    expect(confirmByReadBack({ status: 'active' }, remote, stale)).toEqual({
      matches: false,
      reason: 'stale',
      fields: [],
    });
    // A stale read says nothing about the change, so it is not a mismatch either.
    expect(confirmByReadBack({ status: 'ended' }, remote, stale)).toMatchObject({
      reason: 'stale',
    });
    expect(
      confirmByReadBack({ status: 'active' }, remote, { kind: 'revision', newestSeen: null }),
    ).toMatchObject({ matches: true });
  });

  it('never confirms a read without a revision when the adapter promised one', () => {
    expect(
      confirmByReadBack({ status: 'active' }, { ...remote, revision: null }, CURRENT),
    ).toMatchObject({ matches: false, reason: 'stale' });
  });

  it('without a freshness marker, confirms only a match that repeats a matching read', () => {
    const plain = { ...remote, revision: null };
    expect(
      confirmByReadBack({ status: 'active' }, plain, {
        kind: 'repeat',
        previousReadMatched: false,
      }),
    ).toEqual({ matches: false, reason: 'unrepeated', fields: [] });
    expect(
      confirmByReadBack({ status: 'active' }, plain, { kind: 'repeat', previousReadMatched: true }),
    ).toMatchObject({ matches: true, proof: { evidence: 'read_back' } });
    expect(
      confirmByReadBack({ status: 'ended' }, plain, { kind: 'repeat', previousReadMatched: true }),
    ).toMatchObject({ matches: false, reason: 'mismatch', fields: ['status'] });
  });
});

describe('confirmByUser', () => {
  it('records who confirmed', () => {
    expect(confirmByUser('user-1')).toEqual({
      evidence: 'user_confirmation',
      detail: { evidence: 'user_confirmation', userId: 'user-1' },
    });
  });
});
