/**
 * Importing listings through the API (real Postgres, docs/features/imports.md): where an import
 * can start and why not, starting one where the marketplace runs, one at a time, its progress in
 * the server's words, and the questions for the seller and their answers, after which the
 * imported listing shows as confirmed by the marketplace's own read.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInventoryItem, jsonb } from '@listora/db';

import { createTestApi, type TestApi } from '../test-support.ts';
import type { Tenant } from '../tenancy.ts';

const OWNER = 'imports.owner@example.com';
const OTHER = 'imports.other@example.com';
const IN_THE_CLOUD = {
  automationEnv: { AUTOMATION_DEPOP_CLOUD_ALLOWED: 'true', AUTOMATION_DEPOP_RUNS_ON: 'cloud' },
};

describe('listing imports (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let otherToken: string;
  let tenant: Tenant;

  beforeAll(async () => {
    api = await createTestApi('imports', IN_THE_CLOUD);
    token = await api.signIn(OWNER);
    otherToken = await api.signIn(OTHER);
    tenant = await api.tenantOf(OWNER);
  });

  afterAll(async () => {
    await api.close();
  });

  const start = (marketplace: string, as = token) =>
    api.call('startListingImport', { token: as, body: { marketplace } });

  it('says why an import cannot start, and starts one on a linked marketplace, one at a time', async () => {
    const before = await api.call('listListingImports', { token });
    expect(before.status).toBe(200);
    expect(before.body.marketplaces.map((entry) => [entry.marketplace, entry.canStart])).toEqual([
      ['depop', false],
      ['poshmark', false],
      ['mercari', false],
    ]);
    expect(before.body.marketplaces[0]?.unavailableReason).toBe(
      'Link Depop in Listora first, so it can read your listings.',
    );
    expect(await start('depop')).toMatchObject({
      status: 409,
      error: { code: 'marketplace_not_connected' },
    });
    expect(await start('ebay')).toMatchObject({
      status: 409,
      error: { code: 'marketplace_action_unavailable' },
    });

    const linked = await api.call('linkMarketplaceSession', {
      token,
      params: { marketplace: 'depop' },
      body: {
        cookies: [
          {
            name: 'access_token',
            value: 'signed-in',
            domain: '.depop.com',
            path: '/',
            expires: Math.floor(Date.now() / 1000) + 86_400,
            httpOnly: false,
            secure: true,
            sameSite: 'lax',
          },
        ],
      },
    });
    expect(linked.status).toBeLessThan(300);
    const started = await start('depop');
    expect(started).toMatchObject({
      status: 202,
      body: {
        marketplace: 'depop',
        status: 'reading',
        runsOn: 'cloud',
        progress: 'Reading your Depop listings in the cloud',
        counts: { read: 0, imported: 0, merged: 0, alreadyListed: 0, needsYou: 0, failed: 0 },
      },
    });
    // The first page waits for the browser runner.
    const { rows } = await sql<{ key: string }>`
      select key from graphile_worker.jobs where task_identifier = 'automation_listing_import'
    `.execute(api.db);
    expect(rows.map((row) => row.key)).toEqual([`listing-import-read:${started.body.id}`]);
    expect(await start('depop')).toMatchObject({ status: 409, error: { code: 'already_exists' } });
    const during = await api.call('listListingImports', { token });
    expect(during.body.marketplaces[0]).toMatchObject({
      canStart: false,
      unavailableReason: 'Listora is importing your Depop listings now.',
      latest: { id: started.body.id, status: 'reading' },
    });
    // Another account sees none of it.
    expect(
      await api.call('getListingImport', {
        token: otherToken,
        params: { importId: started.body.id },
      }),
    ).toMatchObject({ status: 404 });
  });

  it("asks the seller about a listing it isn't sure of, and the answer lists the item there", async () => {
    const importRow = await api.db
      .selectFrom('listing_import')
      .selectAll()
      .where('account_id', '=', tenant.accountId)
      .executeTakeFirstOrThrow();
    const item = await createInventoryItem(api.db, tenant.accountId, {
      title: 'Floral maxi dress',
      status: 'ready',
    });
    const other = await createInventoryItem(api.db, tenant.accountId, { title: 'Wool scarf' });
    const entry = await api.db
      .insertInto('listing_import_entry')
      .values({
        account_id: tenant.accountId,
        import_id: importRow.id,
        marketplace: 'depop',
        external_listing_id: 'seller-floral-dress',
        outcome: 'needs_you',
        settled_at: new Date(),
        candidates: jsonb([{ itemId: item.id, reason: 'photo' }]),
        listing: jsonb({
          found: true,
          externalListingId: 'seller-floral-dress',
          externalUrl: 'https://www.depop.com/products/seller-floral-dress/',
          status: 'active',
          title: null,
          description: 'Floral maxi dress, worn once.',
          priceCents: 3400,
          currency: 'USD',
          revision: 1_761_000_000_000,
          details: {
            photoUrls: ['https://media-photos.depop.com/b1/one.jpg'],
            brand: null,
            size: 'S',
            condition: 'pre_owned_good',
            categoryRef: null,
            categoryPath: [],
            sku: null,
          },
        }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await api.db
      .updateTable('listing_import')
      .set({
        status: 'finished',
        read_at: new Date(),
        finished_at: new Date(),
        listings_read: 1,
        needs_you: 1,
      })
      .where('id', '=', importRow.id)
      .execute();

    const questions = await api.call('listListingImportQuestions', {
      token,
      params: { importId: importRow.id },
    });
    expect(questions.body).toEqual({
      questions: [
        {
          id: entry.id,
          marketplace: 'depop',
          externalListingId: 'seller-floral-dress',
          externalUrl: 'https://www.depop.com/products/seller-floral-dress/',
          title: 'Floral maxi dress, worn once.',
          price: { amountCents: 3400, currency: 'USD' },
          photoUrl: 'https://media-photos.depop.com/b1/one.jpg',
          candidates: [
            {
              itemId: item.id,
              sku: item.sku,
              title: 'Floral maxi dress',
              reason: 'photo',
              why: 'A photo looks the same',
            },
          ],
        },
      ],
    });
    const answer = (body: unknown) =>
      api.call('answerListingImportQuestion', {
        token,
        params: { importId: importRow.id, questionId: entry.id },
        body,
      });
    expect(await answer({ answer: 'same_item' })).toMatchObject({ status: 422 });
    expect(await answer({ answer: 'same_item', itemId: other.id })).toMatchObject({ status: 422 });
    expect(await answer({ answer: 'same_item', itemId: item.id })).toMatchObject({
      status: 200,
      body: {
        status: 'finished',
        counts: { merged: 1, needsYou: 0 },
        summary: 'Imported 1 from Depop',
      },
    });
    expect(await answer({ answer: 'skip' })).toMatchObject({
      status: 409,
      error: { code: 'invalid_state_transition' },
    });
    // The import's read is the listing's read-back: active, confirmed by Depop, the item listed.
    const shown = await api.call('getItem', { token, params: { itemId: item.id } });
    expect(shown.body.status).toBe('listed');
    const depop = shown.body.listings.find((found) => found.marketplace === 'depop');
    expect(depop?.statusDisplay.label).toBe('Active (confirmed by Depop)');
    expect(depop?.externalUrl).toBe('https://www.depop.com/products/seller-floral-dress/');
  });
});
