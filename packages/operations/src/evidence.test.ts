import { describe, expect, it } from 'vitest';

import type { RemoteListingState } from '@listora/marketplaces';

import { confirmByReadBack, confirmByUser } from './evidence.ts';

const remote: RemoteListingState = {
  found: true,
  externalListingId: 'EBAY-1',
  externalUrl: 'https://example.invalid/EBAY-1',
  status: 'active',
  title: 'Denim jacket',
  description: 'Size M',
  priceCents: 4500,
  currency: 'USD',
};

describe('confirmByReadBack', () => {
  it('returns a read-back proof only when every desired field matches', () => {
    const result = confirmByReadBack({ status: 'active', priceCents: 4500 }, remote);
    expect(result).toMatchObject({
      matches: true,
      proof: {
        evidence: 'read_back',
        detail: {
          evidence: 'read_back',
          remote: { externalListingId: 'EBAY-1', priceCents: 4500 },
        },
      },
    });
  });

  it('names the fields that do not match', () => {
    expect(confirmByReadBack({ priceCents: 3900, title: 'Denim jacket' }, remote)).toEqual({
      matches: false,
      reason: 'mismatch',
      fields: ['priceCents'],
    });
    expect(confirmByReadBack({ status: 'ended' }, { ...remote, status: 'sold' })).toMatchObject({
      matches: false,
      fields: ['status'],
    });
  });

  it('never confirms a listing that was not found', () => {
    expect(confirmByReadBack({ status: 'ended' }, { found: false })).toEqual({
      matches: false,
      reason: 'not_found',
      fields: [],
    });
  });

  it('never confirms an empty desired state', () => {
    expect(confirmByReadBack({}, remote)).toEqual({
      matches: false,
      reason: 'nothing_desired',
      fields: [],
    });
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
