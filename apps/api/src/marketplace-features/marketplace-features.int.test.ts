/**
 * The marketplace feature gate in the API (docs/features/verified-features.md), on real
 * Postgres, with the features that passed live (every deployment's set): the app is told each
 * marketplace's verified features; a feature not verified (Poshmark's offers and sales today,
 * offer answers everywhere) queues no check, and shows no row, button, or error anywhere the
 * seller looks (Sync, Tasks, Import listings); and a failed read of a verified feature carries no
 * error for the seller.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { knownMarketplaceFeatureValues } from '@listora/api-contract';
import type { Marketplace } from '@listora/db';
import { MARKETPLACE_FEATURES, useMarketplaceFeatures } from '@listora/marketplaces';

import { createTestApi, type TestApi } from '../test-support.ts';

describe('marketplace features (real Postgres, verified features)', () => {
  let api: TestApi;
  let sequence = 0;

  beforeAll(async () => {
    useMarketplaceFeatures('verified');
    api = await createTestApi('marketplace_features');
  });

  afterAll(async () => {
    await api.close();
    useMarketplaceFeatures('all');
  });

  /** A signed-in seller whose marketplaces are linked on their iPhone. */
  async function seller(marketplaces: Marketplace[]) {
    sequence += 1;
    const email = `features.${String(sequence)}@example.com`;
    const token = await api.signIn(email);
    const { accountId } = await api.tenantOf(email);
    const ids: Partial<Record<Marketplace, string>> = {};
    for (const marketplace of marketplaces) {
      const row = await api.db
        .insertInto('marketplace_connection')
        .values({
          account_id: accountId,
          marketplace,
          mode: 'automation',
          status: 'connected',
          token_ciphertext: Buffer.from('sealed'),
          runs_on: 'phone',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids[marketplace] = row.id;
    }
    const phoneWork = async () =>
      (
        await api.db
          .selectFrom('phone_work')
          .select(['marketplace', 'purpose'])
          .where('account_id', '=', accountId)
          .orderBy('marketplace')
          .orderBy('purpose')
          .execute()
      ).map((row) => `${row.marketplace}:${row.purpose}`);
    return { token, accountId, ids, phoneWork };
  }

  /** A pending offer the phone read on the connection, with its open task. */
  async function pendingOffer(
    accountId: string,
    connectionId: string,
    marketplace: 'depop' | 'poshmark',
  ) {
    sequence += 1;
    const offer = await api.db
      .insertInto('marketplace_offer')
      .values({
        account_id: accountId,
        connection_id: connectionId,
        marketplace,
        external_offer_id: `offer-${String(sequence)}`,
        listing_title: 'Wool scarf',
        amount_cents: 3000,
        list_price_cents: 4000,
        buyer_name: 'scarffan',
        offer_url: `https://www.${marketplace}.com/offers/${String(sequence)}/`,
        expires_at: new Date(Date.now() + 3_600_000),
      })
      .returning(['id', 'offer_url'])
      .executeTakeFirstOrThrow();
    await api.db
      .insertInto('user_task')
      .values({
        account_id: accountId,
        kind: 'answer_offer',
        offer_id: offer.id,
        deep_link: offer.offer_url,
      })
      .execute();
    return offer;
  }

  it('tells the app each marketplace’s verified features, the same list as the contract’s', async () => {
    expect([...knownMarketplaceFeatureValues]).toEqual([...MARKETPLACE_FEATURES]);
    const token = await api.signIn('features.list@example.com');
    const listed = await api.call('listMarketplaceFeatures', { token });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([
      { marketplace: 'ebay', features: [] },
      {
        marketplace: 'depop',
        features: ['sales_history', 'sale_checks', 'offers', 'listing_import'],
      },
      { marketplace: 'poshmark', features: [] },
      { marketplace: 'mercari', features: ['sales_history', 'sale_checks', 'listing_import'] },
    ]);
  });

  it('syncs only the verified reads, and leaves a marketplace with none out of the sync', async () => {
    const { token, phoneWork } = await seller(['depop', 'poshmark', 'mercari']);
    const synced = await api.call('requestSync', { token });
    expect(synced.status).toBe(200);
    // Poshmark's sale checks and offer reads never passed live: nothing of it is queued or shown.
    expect(await phoneWork()).toEqual([
      'depop:offer_check',
      'depop:sale_check',
      'mercari:sale_check',
    ]);
    expect(synced.body.data.map((sync) => sync.marketplace)).toEqual(['depop', 'mercari']);
    const status = await api.call('getSyncStatus', { token });
    expect(status.body.data.map((sync) => sync.marketplace)).toEqual(['depop', 'mercari']);
  });

  it('reads no hidden offers, and a failed read reaches the seller as no error', async () => {
    const { token, accountId, ids, phoneWork } = await seller(['depop', 'poshmark']);
    const asked = await api.call('requestOfferChecks', { token });
    expect(asked.body.data).toEqual([{ marketplace: 'depop', status: 'waiting' }]);
    expect(await phoneWork()).toEqual(['depop:offer_check']);

    // Reads that failed earlier, on both (as Poshmark's did before it was hidden).
    await api.db.deleteFrom('phone_work').where('account_id', '=', accountId).execute();
    for (const marketplace of ['depop', 'poshmark'] as const) {
      await api.db
        .insertInto('offer_check')
        .values({
          account_id: accountId,
          connection_id: ids[marketplace] ?? '',
          marketplace,
          requested_at: new Date(),
          last_outcome: 'failed',
          last_error_code: 'element_missing',
          last_error_message: `Listora couldn't read your offers on ${marketplace}'s offers page.`,
        })
        .onConflict((conflict) =>
          conflict.columns(['account_id', 'connection_id']).doUpdateSet({
            last_outcome: 'failed',
            last_error_code: 'element_missing',
            last_error_message: 'failed',
          }),
        )
        .execute();
    }
    const checks = await api.call('listOfferChecks', { token });
    expect(checks.body.data).toEqual([{ marketplace: 'depop', status: 'failed' }]);
    expect(JSON.stringify(checks.body)).not.toContain("couldn't");
    const status = await api.call('getSyncStatus', { token });
    expect(status.body.data.map((sync) => sync.marketplace)).toEqual(['depop']);
  });

  it('shows no answers where they never passed live, refuses one, and hides a hidden marketplace’s offers', async () => {
    const { token, accountId, ids } = await seller(['depop', 'poshmark']);
    const depop = await pendingOffer(accountId, ids.depop ?? '', 'depop');
    const poshmark = await pendingOffer(accountId, ids.poshmark ?? '', 'poshmark');
    const tasks = await api.call('listTasks', { token, query: { status: ['open'] } });
    const offers = tasks.body.data.flatMap((task) =>
      task.offer === undefined ? [] : [task.offer],
    );
    // The Poshmark offer's task doesn't show; the Depop one shows with no Accept, Decline, or
    // Counter, and says where to answer it.
    expect(offers.map((offer) => offer.id)).toEqual([depop.id]);
    expect(offers[0]).toMatchObject({ actions: [], acceptNote: 'Answer this offer in Depop.' });
    expect(offers[0]?.counterRange).toBeUndefined();

    const refused = await api.call('answerOffer', {
      token,
      params: { offerId: depop.id },
      body: { action: 'accept', offerAmount: { amountCents: 3000, currency: 'USD' } },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'marketplace_action_unavailable',
      message: 'Answer this offer in Depop.',
    });
    const responses = await api.db
      .selectFrom('offer_response')
      .select('id')
      .where('account_id', '=', accountId)
      .execute();
    expect(responses).toEqual([]);
    const hidden = await api.call('getOffer', { token, params: { offerId: poshmark.id } });
    expect(hidden.status).toBe(404);
  });

  it('offers imports only from marketplaces whose imports passed live', async () => {
    const { token } = await seller(['depop', 'poshmark', 'mercari']);
    const listed = await api.call('listListingImports', { token });
    expect(listed.body.marketplaces.map((entry) => entry.marketplace)).toEqual([
      'depop',
      'mercari',
    ]);
    const refused = await api.call('startListingImport', {
      token,
      body: { marketplace: 'poshmark' },
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });
});
