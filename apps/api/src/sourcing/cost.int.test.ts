/**
 * Where the household sources, in Settings through the API (real Postgres): the bins at $1.99 a
 * pound until the seller saves their own, a thrift store with or without its own price per
 * item, going back to the default, refusing prices out of bounds, and who may change it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';

const OWNER = 'cost.owner@example.com';
const OTHER = 'cost.other@example.com';
const MEMBER = 'cost.member@example.com';

const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });
const DEFAULT = { mode: 'bins', binsPricePerPound: usd(199), isDefault: true };

describe('where the household sources (real Postgres)', () => {
  let api: TestApi;
  let token: string;

  beforeAll(async () => {
    api = await createTestApi('sourcing_cost');
    token = await api.signIn(OWNER);
  });

  afterAll(async () => {
    await api.close();
  });

  it('starts at the bins at $1.99 a pound', async () => {
    const result = await api.call('getSourcingCost', { token });
    expect(result.status).toBe(200);
    expect(result.body).toEqual(DEFAULT);
  });

  it("saves the bins' own price per pound, and a thrift store with or without its own price", async () => {
    const bins = await api.call('replaceSourcingCost', {
      token,
      body: { mode: 'bins', binsPricePerPound: usd(149) },
    });
    expect(bins.body).toEqual({ mode: 'bins', binsPricePerPound: usd(149), isDefault: false });
    const store = await api.call('replaceSourcingCost', {
      token,
      body: { mode: 'store', binsPricePerPound: usd(149), storeItemPrice: usd(600) },
    });
    expect(store.body).toEqual({
      mode: 'store',
      binsPricePerPound: usd(149),
      storeItemPrice: usd(600),
      isDefault: false,
    });
    expect((await api.call('getSourcingCost', { token })).body).toEqual(store.body);
    const typical = await api.call('replaceSourcingCost', { token, body: { mode: 'store' } });
    expect(typical.body).toEqual({ mode: 'store', binsPricePerPound: usd(199), isDefault: false });
  });

  it('refuses a price out of bounds or not in dollars, and keeps the saved one', async () => {
    await api.call('replaceSourcingCost', { token, body: { mode: 'store' } });
    const tooLow = await api.call('replaceSourcingCost', {
      token,
      body: { mode: 'bins', binsPricePerPound: usd(5), storeItemPrice: usd(200_000) },
    });
    expect(tooLow.status).toBe(422);
    expect(fieldsOf(tooLow)).toEqual(['binsPricePerPound', 'storeItemPrice']);
    const euros = await api.call('replaceSourcingCost', {
      token,
      body: {
        mode: 'bins',
        binsPricePerPound: { amountCents: 199, currency: 'EUR' as 'USD' },
      },
    });
    expect(euros.status).toBe(422);
    expect((await api.call('getSourcingCost', { token })).body).toMatchObject({ mode: 'store' });
  });

  it('goes back to the default when saved as the default, keeping no row', async () => {
    const reset = await api.call('replaceSourcingCost', {
      token,
      body: { mode: 'bins', binsPricePerPound: usd(199) },
    });
    expect(reset.body).toEqual(DEFAULT);
    const tenant = await api.tenantOf(OWNER);
    const rows = await api.db
      .selectFrom('sourcing_cost')
      .select('mode')
      .where('account_id', '=', tenant.accountId)
      .execute();
    expect(rows).toEqual([]);
  });

  it("keeps each account's setting to itself, and lets a member read it but not change it", async () => {
    await api.call('replaceSourcingCost', { token, body: { mode: 'store' } });
    const other = await api.signIn(OTHER);
    expect((await api.call('getSourcingCost', { token: other })).body).toEqual(DEFAULT);

    const memberToken = await api.signIn(MEMBER);
    const member = await api.tenantOf(MEMBER);
    const owner = await api.tenantOf(OWNER);
    // Move the member into the owner's account.
    await api.db.deleteFrom('membership').where('user_id', '=', member.userId).execute();
    await api.db.deleteFrom('account').where('id', '=', member.accountId).execute();
    await api.db
      .insertInto('membership')
      .values({ account_id: owner.accountId, user_id: member.userId, role: 'member' })
      .execute();
    expect((await api.call('getSourcingCost', { token: memberToken })).body).toMatchObject({
      mode: 'store',
    });
    const refused = await api.call('replaceSourcingCost', {
      token: memberToken,
      body: { mode: 'bins' },
    });
    expect(refused.status).toBe(403);
    expect(refused.error.code).toBe('forbidden');
  });
});
