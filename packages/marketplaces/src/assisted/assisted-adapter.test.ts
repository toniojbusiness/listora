/**
 * Assisted adapter behaviour beyond the conformance suite (assisted.conformance.test.ts): deep
 * links, marketplace limits, and the flags an assisted marketplace may and may not set.
 */
import { describe, expect, it } from 'vitest';

import type { ListingRef, OperationRequest } from '../adapter.ts';
import { desiredStateForContent } from '../content.ts';
import { sampleListingContent } from '../testing.ts';
import { AssistedAdapter, type AssistedListingPayload } from './assisted-adapter.ts';
import { createPoshmarkAdapter } from './marketplaces.ts';

function ref(externalUrl: string | null): ListingRef {
  return { listingId: 'listing-1', externalListingId: 'p-1', externalSku: null, externalUrl };
}

function end(listing: ListingRef): OperationRequest<AssistedListingPayload> {
  return {
    operationId: 'op-1',
    kind: 'end',
    idempotencyKey: 'key-1',
    attempt: 1,
    desired: { status: 'ended' },
    listing,
    payload: null,
  };
}

describe('AssistedAdapter', () => {
  const poshmark = createPoshmarkAdapter();

  it.each([
    ['the listing page the user linked', 'https://poshmark.com/listing/Jacket-123', true],
    ['a page on a subdomain', 'https://www.poshmark.com/listing/Jacket-123', true],
    ['a page over plain http', 'http://poshmark.com/listing/Jacket-123', false],
    ['a look-alike domain', 'https://evilposhmark.com/listing/Jacket-123', false],
    ['another site', 'https://example.com/poshmark.com/listing', false],
    ['text that is not a URL', 'poshmark listing', false],
  ])('links a delist task to %s only when it is on the marketplace', async (_case, url, used) => {
    const outcome = await poshmark.execute(end(ref(url)));
    expect(outcome).toMatchObject({
      type: 'pendingUser',
      task: { kind: 'delist_manually', deepLink: used ? url : 'https://poshmark.com/' },
    });
  });

  it('opens the marketplace for a new listing, never an old listing page', async () => {
    const content = sampleListingContent();
    const outcome = await poshmark.execute({
      ...end(ref('https://poshmark.com/listing/Jacket-123')),
      kind: 'relist',
      desired: desiredStateForContent('relist', content),
      payload: poshmark.buildPayload(content.item, content.variant),
    });
    expect(outcome).toMatchObject({
      task: { kind: 'list_manually', deepLink: 'https://poshmark.com/' },
    });
  });

  it('enforces the limits it is configured with', () => {
    const limited = new AssistedAdapter({
      marketplace: 'mercari',
      siteUrl: 'https://www.mercari.com/',
      limits: { titleMaxLength: 30, descriptionMaxLength: 20, maxPhotos: 2 },
    });
    const { item, variant } = sampleListingContent();
    expect(limited.validate(limited.buildPayload(item, variant))).toEqual([
      {
        field: 'variant.title',
        code: 'too_long',
        message: 'Mercari titles can be at most 30 characters.',
      },
      {
        field: 'variant.description',
        code: 'too_long',
        message: 'Mercari descriptions can be at most 20 characters.',
      },
      { field: 'item.photos', code: 'too_many', message: 'Mercari takes at most 2 photos.' },
    ]);
  });

  it('never marks listings sold itself where the marketplace does that', async () => {
    expect(poshmark.capabilities().markSold).toBe('not_needed');
    expect(
      await poshmark.execute({ ...end(ref(null)), kind: 'mark_sold', desired: { status: 'sold' } }),
    ).toMatchObject({
      type: 'rejected',
      code: 'not_supported',
      message: "Listora can't mark listings sold on Poshmark.",
    });
  });

  it('refuses a content change that arrives without its listing details', async () => {
    expect(
      await poshmark.execute({
        ...end(ref(null)),
        kind: 'create',
        desired: { status: 'active' },
        payload: null,
      }),
    ).toMatchObject({ type: 'rejected', code: 'missing_content' });
  });

  it('cannot be configured to promise an api write or a read-back', () => {
    expect(
      () =>
        new AssistedAdapter({
          marketplace: 'poshmark',
          siteUrl: 'https://poshmark.com/',
          capabilities: { delist: 'api' },
        }),
    ).toThrow('an assisted adapter cannot have delist: api');
    expect(
      () => new AssistedAdapter({ marketplace: 'poshmark', siteUrl: 'http://poshmark.com/' }),
    ).toThrow('siteUrl must be an https:// URL');
    expect(poshmark.capabilities()).toMatchObject({
      connect: 'none',
      verifyRead: 'user_confirm',
      readFreshness: 'none',
      imageTransport: 'user_saves_photos',
    });
  });

  it('has nothing to check for connection health', async () => {
    expect(await poshmark.healthCheck()).toEqual({ status: 'ok' });
  });
});
