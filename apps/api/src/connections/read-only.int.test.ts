/**
 * Read-only connections through the API (docs/features/read-only.md), on real Postgres: the
 * owner turns Read only on and off, both screens say so, a read-only listing offers only its
 * check, and every change to it is refused with `409 connection_read_only` before anything is
 * queued. The engine's and the hosts' own refusals are tested in their packages.
 */
import { randomUUID } from 'node:crypto';

import { PHONE_RUNTIME_VERSION } from '@listora/automation';
import { createInventoryItem } from '@listora/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';

const SELLER = 'read-only-seller@example.com';

describe('read-only connections in the API (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let accountId: string;
  let listingId: string;

  beforeAll(async () => {
    api = await createTestApi('read_only');
    token = await api.signIn(SELLER);
    accountId = (await api.tenantOf(SELLER)).accountId;
    const installationId = randomUUID();
    await api.call('registerDevice', {
      token,
      params: { installationId },
      body: { name: "Sam's iPhone", platform: 'ios', runtimeVersion: PHONE_RUNTIME_VERSION },
    });
    const linked = await api.call('linkMarketplaceSession', {
      token,
      params: { marketplace: 'depop' },
      body: {
        installationId,
        cookies: [
          {
            name: 'access_token',
            value: 'depop-session-secret',
            domain: '.depop.com',
            path: '/',
            expires: Math.floor(Date.now() / 1000) + 86_400,
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
          },
        ],
      },
    });
    expect(linked.status).toBe(201);
    expect(linked.body.readOnly).toBe(false);
    // A listing live on the linked shop, as an import leaves it.
    const { id: connectionId } = await api.db
      .selectFrom('marketplace_connection')
      .select('id')
      .where('account_id', '=', accountId)
      .where('marketplace', '=', 'depop')
      .executeTakeFirstOrThrow();
    const item = await createInventoryItem(api.db, accountId, { title: 'Wool scarf' });
    ({ id: listingId } = await api.db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: item.id,
        marketplace: 'depop',
        connection_id: connectionId,
        status: 'active',
        external_listing_id: 'wool-scarf-1',
        title: 'Wool scarf',
        price_cents: 1500,
      })
      .returning('id')
      .executeTakeFirstOrThrow());
  });

  afterAll(async () => {
    await api.close();
  });

  const setReadOnly = (readOnly: boolean, marketplace: 'depop' | 'poshmark' = 'depop') =>
    api.call('setConnectionReadOnly', { token, params: { marketplace }, body: { readOnly } });
  const listing = () => api.call('getListing', { token, params: { listingId } });

  it('lets the owner make the shop read only, and both screens say so', async () => {
    const set = await setReadOnly(true);
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ marketplace: 'depop', readOnly: true });
    const connection = await api.call('getConnection', {
      token,
      params: { marketplace: 'depop' },
    });
    expect(connection.body.readOnly).toBe(true);
    const session = await api.call('getMarketplaceSession', {
      token,
      params: { marketplace: 'depop' },
    });
    expect(session.body.readOnly).toBe(true);
    // A marketplace that isn't linked has nothing to make read only.
    expect(
      (await api.call('getConnection', { token, params: { marketplace: 'poshmark' } })).body,
    ).toMatchObject({ readOnly: false });
    expect((await setReadOnly(true, 'poshmark')).status).toBe(404);
    // The change is in the account's history.
    const audit = await api.db
      .selectFrom('audit_log')
      .select(['action', 'changes'])
      .where('account_id', '=', accountId)
      .where('action', '=', 'connection.read_only_changed')
      .execute();
    expect(audit).toEqual([
      expect.objectContaining({
        changes: expect.objectContaining({ readOnly: { from: false, to: true } }) as unknown,
      }),
    ]);
  });

  it('offers no change on a read-only listing, refuses each one, and queues nothing', async () => {
    await setReadOnly(true);
    expect((await listing()).body.availableActions.map((entry) => entry.action)).not.toEqual(
      expect.arrayContaining(['end']),
    );
    const refusals = [
      await api.call('endListing', { token, params: { listingId }, body: { reason: 'other' } }),
      await api.call('changeListingPrice', {
        token,
        params: { listingId },
        body: { price: { amountCents: 1200, currency: 'USD' } },
      }),
    ];
    for (const refused of refusals) {
      expect(refused.status).toBe(409);
      expect(refused.error).toMatchObject({
        code: 'connection_read_only',
        message:
          "Your Depop account is read only, so Listora won't change anything on it. To let Listora change it, turn off Read only for Depop in Link accounts.",
        retryable: false,
      });
    }
    const operations = await api.db
      .selectFrom('marketplace_operation')
      .select('id')
      .where('listing_id', '=', listingId)
      .execute();
    expect(operations).toEqual([]);
    expect((await listing()).body).toMatchObject({ status: 'active' });
  });

  it('lets Listora change the shop again once the owner turns Read only off', async () => {
    await setReadOnly(true);
    expect((await setReadOnly(false)).body).toMatchObject({ readOnly: false });
    expect((await listing()).body.availableActions.map((entry) => entry.action)).toContain('end');
    const ended = await api.call('endListing', {
      token,
      params: { listingId },
      body: { reason: 'other' },
    });
    expect(ended.status).toBe(202);
  });

  it("refuses the change to anyone but the account's owner", async () => {
    await api.db
      .updateTable('membership')
      .set({ role: 'member' })
      .where('account_id', '=', accountId)
      .execute();
    try {
      const refused = await setReadOnly(false);
      expect(refused.status).toBe(403);
      expect(refused.error).toMatchObject({ code: 'forbidden' });
    } finally {
      await api.db
        .updateTable('membership')
        .set({ role: 'owner' })
        .where('account_id', '=', accountId)
        .execute();
    }
  });
});
