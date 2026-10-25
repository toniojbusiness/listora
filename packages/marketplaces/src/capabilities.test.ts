import { describe, expect, it } from 'vitest';

import { OPERATION_KINDS } from '@listora/db';

import type { MarketplaceCapabilities } from './adapter.ts';
import { checkCapabilities, operationMode, readBackState } from './capabilities.ts';

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
  title: 'field',
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

const AUTOMATION: MarketplaceCapabilities = {
  ...API,
  connect: 'session',
  create: 'automation',
  updatePrice: 'automation',
  updateDetails: 'automation',
  delist: 'automation',
  relist: 'automation',
  markSold: 'not_needed',
  verifyRead: 'automation',
  readFreshness: 'none',
  importListings: 'share_sheet',
  saleDetection: ['poll', 'email', 'manual'],
  imageTransport: 'upload',
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

  it('routes automated kinds to the browser runner, verified through the same session', () => {
    expect(
      Object.fromEntries(OPERATION_KINDS.map((kind) => [kind, operationMode(AUTOMATION, kind)])),
    ).toEqual({
      create: 'automation',
      revise: 'automation',
      price: 'automation',
      end: 'automation',
      relist: 'automation',
      mark_sold: 'unsupported',
      verify: 'automation',
    });
    // Each kind switches on its own: an automated delist next to an assisted create.
    expect(operationMode({ ...AUTOMATION, create: 'assisted' }, 'create')).toBe('assisted');
    expect(operationMode({ ...AUTOMATION, create: 'assisted' }, 'end')).toBe('automation');
  });

  it('never routes a write that nothing can read back through its own channel', () => {
    const blind: MarketplaceCapabilities = { ...API, verifyRead: 'user_confirm' };
    expect(operationMode(blind, 'create')).toBe('unsupported');
    expect(operationMode(blind, 'verify')).toBe('unsupported');
    expect(operationMode({ ...AUTOMATION, verifyRead: 'api' }, 'end')).toBe('unsupported');
    expect(operationMode({ ...API, verifyRead: 'automation' }, 'end')).toBe('unsupported');
  });
});

describe('checkCapabilities', () => {
  it('accepts coherent api, automation, and assisted flags', () => {
    expect(checkCapabilities(API)).toEqual([]);
    expect(checkCapabilities(AUTOMATION)).toEqual([]);
    expect(checkCapabilities({ ...AUTOMATION, readFreshness: 'revision' })).toEqual([]);
    expect(checkCapabilities(ASSISTED)).toEqual([]);
  });

  it('refuses writes or freshness markers without read-backs through the same channel', () => {
    expect(checkCapabilities({ ...ASSISTED, delist: 'api', readFreshness: 'revision' })).toEqual([
      'delist is api, but verifyRead is not: no read-back could confirm it',
      'readFreshness needs read-backs: there are no reads to mark',
    ]);
    expect(checkCapabilities({ ...API, relist: 'automation' })).toEqual([
      'relist is automation, but verifyRead is not: no read-back could confirm it',
    ]);
  });

  it('refuses automated reads without a seller session', () => {
    expect(checkCapabilities({ ...AUTOMATION, connect: 'oauth' })).toEqual([
      'verifyRead automation needs connect session: reads run in the seller session',
    ]);
  });

  it('refuses limits that are not positive integers', () => {
    expect(checkCapabilities({ ...API, limits: { appPerMin: 0, perSellerPerMin: 1.5 } })).toEqual([
      'limits.appPerMin must be a positive integer',
      'limits.perSellerPerMin must be a positive integer',
    ]);
  });
});

describe('readBackState', () => {
  const desired = {
    status: 'active',
    title: 'Headline',
    description: 'Copy',
    priceCents: 4500,
    currency: 'USD',
  } as const;

  it('checks every desired field where listings have titles', () => {
    expect(readBackState(desired, API)).toEqual(desired);
  });

  it('never checks a title where listings have none', () => {
    const { title, ...shown } = desired;
    expect(readBackState(desired, { ...API, title: 'none' })).toEqual(shown);
    // The desired state itself keeps its title.
    expect(desired.title).toBe(title);
  });
});
