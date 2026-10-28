import { describe, expect, it } from 'vitest';

import type { RemoteListingState } from '@listora/marketplaces';

import {
  confirmByReadBack,
  confirmByUser,
  confirmEveryReadBack,
  type Freshness,
  type SuccessProof,
} from './evidence.ts';

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
  refreshedAt: null,
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

  it('never confirms a listing that was not found, unless the absence is authoritative', () => {
    expect(
      confirmByReadBack({ status: 'ended' }, { found: false, authoritative: false }, CURRENT),
    ).toEqual({ matches: false, reason: 'not_found', fields: [] });
  });

  it('counts an authoritative absence as done only for an end or mark-sold', () => {
    const absent = { found: false, authoritative: true } as const;
    for (const status of ['ended', 'sold'] as const) {
      expect(confirmByReadBack({ status }, absent, CURRENT)).toMatchObject({
        matches: true,
        proof: {
          evidence: 'read_back',
          detail: { remote: { found: false, authoritative: true } },
        },
      });
    }
    // A create or relist is never confirmed by an absence, nor an edit that comes with it.
    expect(confirmByReadBack({ status: 'active' }, absent, CURRENT)).toMatchObject({
      matches: false,
      reason: 'not_found',
    });
    expect(confirmByReadBack({ status: 'ended', title: 'Coat' }, absent, CURRENT)).toMatchObject({
      matches: false,
      reason: 'not_found',
    });
    // Without a freshness marker, an absence must repeat like any other match.
    expect(
      confirmByReadBack({ status: 'ended' }, absent, {
        kind: 'repeat',
        previousReadMatched: false,
      }),
    ).toMatchObject({ matches: false, reason: 'unrepeated' });
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

describe('confirmEveryReadBack', () => {
  function proofOf(externalListingId: string): SuccessProof {
    const ended: RemoteListingState = {
      found: true,
      externalListingId,
      externalUrl: null,
      status: 'ended',
      title: null,
      description: null,
      priceCents: null,
      currency: null,
      revision: 7,
      refreshedAt: null,
    };
    const result = confirmByReadBack({ status: 'ended' }, ended, CURRENT);
    if (!result.matches) throw new Error('expected a proof');
    return result.proof;
  }

  it('keeps a single proof as it is', () => {
    const proof = proofOf('EBAY-1');
    expect(confirmEveryReadBack([proof])).toBe(proof);
  });

  it('joins the read-backs of every targeted listing, the primary one first', () => {
    expect(confirmEveryReadBack([proofOf('EBAY-2'), proofOf('EBAY-1')])).toMatchObject({
      evidence: 'read_back',
      detail: {
        remote: { externalListingId: 'EBAY-2' },
        otherRemotes: [{ externalListingId: 'EBAY-1' }],
      },
    });
  });

  it('never joins a user confirmation', () => {
    expect(() => confirmEveryReadBack([proofOf('EBAY-1'), confirmByUser('user-1')])).toThrow();
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
