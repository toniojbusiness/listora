import { describe, expect, it } from 'vitest';

import { OPERATION_KINDS } from '@listora/db';

import type { MarketplaceCapabilities } from './adapter.ts';
import { checkCapabilities, operationMode } from './capabilities.ts';

const API: MarketplaceCapabilities = {
  connect: 'oauth',
  create: 'api',
  updatePrice: 'api',
  updateDetails: 'api',
  delist: 'api',
  relist: 'api',
  markSold: 'api',
  verifyRead: 'api',
  readFreshness: 'revision',
  importListings: 'api',
  saleDetection: ['webhook', 'poll'],
  imageTransport: 'url_fetch',
  taxonomy: 'api',
  pricingData: 'none',
  externalSkuReusable: true,
  limits: { appPerDay: 5000 },
};

const ASSISTED: MarketplaceCapabilities = {
  ...API,
  connect: 'none',
  create: 'assisted',
  updatePrice: 'assisted',
  updateDetails: 'assisted',
  delist: 'assisted',
  relist: 'assisted',
  markSold: 'not_needed',
  verifyRead: 'user_confirm',
  readFreshness: 'none',
  limits: {},
};

describe('operationMode', () => {
  it('routes every kind of an api marketplace through the api', () => {
    expect(OPERATION_KINDS.map((kind) => operationMode(API, kind))).toEqual(
      OPERATION_KINDS.map(() => 'api'),
    );
  });

  it('routes an assisted marketplace to the user, and verifies nothing itself', () => {
    expect(
      Object.fromEntries(OPERATION_KINDS.map((kind) => [kind, operationMode(ASSISTED, kind)])),
    ).toEqual({
      create: 'assisted',
      revise: 'assisted',
      price: 'assisted',
      end: 'assisted',
      relist: 'assisted',
      mark_sold: 'unsupported',
      verify: 'unsupported',
    });
  });

  it('maps each kind to its own flag', () => {
    const mixed: MarketplaceCapabilities = {
      ...API,
      updatePrice: 'assisted',
      relist: 'none',
      markSold: 'bulk_file',
    };
    expect(operationMode(mixed, 'create')).toBe('api');
    expect(operationMode(mixed, 'revise')).toBe('api');
    expect(operationMode(mixed, 'price')).toBe('assisted');
    expect(operationMode(mixed, 'relist')).toBe('unsupported');
    expect(operationMode(mixed, 'mark_sold')).toBe('unsupported');
  });

  it('never routes an api write that nothing can read back', () => {
    const blind: MarketplaceCapabilities = { ...API, verifyRead: 'user_confirm' };
    expect(operationMode(blind, 'create')).toBe('unsupported');
    expect(operationMode(blind, 'verify')).toBe('unsupported');
  });
});

describe('checkCapabilities', () => {
  it('accepts coherent api and assisted flags', () => {
    expect(checkCapabilities(API)).toEqual([]);
    expect(checkCapabilities(ASSISTED)).toEqual([]);
  });

  it('refuses api writes or freshness markers without api reads', () => {
    expect(checkCapabilities({ ...ASSISTED, delist: 'api', readFreshness: 'revision' })).toEqual([
      'delist is api, but verifyRead is not: no read-back could confirm it',
      'readFreshness needs verifyRead api: there are no reads to mark',
    ]);
  });

  it('refuses limits that are not positive integers', () => {
    expect(checkCapabilities({ ...API, limits: { appPerMin: 0, perSellerPerMin: 1.5 } })).toEqual([
      'limits.appPerMin must be a positive integer',
      'limits.perSellerPerMin must be a positive integer',
    ]);
  });
});
