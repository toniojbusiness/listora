/**
 * Test mode (docs/features/test-mode.md), on real Postgres with the features that passed live
 * (every deployment's set): only the owner or an admin of the deployment owner's account sees
 * the switch and may turn it on; with it on, that account gets every built feature (the untested
 * ones tagged `testing`) and the server accepts them from it alone; a customer never sees Test
 * mode or a hidden feature; a read-only connection stays read-only; and each run of a hidden
 * feature lands in the owner's log.
 */
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordReadFailed, recordReadSucceeded } from '@listora/automation';
import type { Marketplace } from '@listora/db';
import {
  MARKETPLACE_FEATURES,
  recordFeatureTestRun,
  useMarketplaceFeatures,
} from '@listora/marketplaces';

import { createTestApi, type TestApi } from '../test-support.ts';

const OWNER = 'owner@example.com';

describe('Test mode (real Postgres, verified features)', () => {
  let api: TestApi;
  let owner: string;
  let ownerAccount: string;
  let people = 0;
  let listings = 0;

  beforeAll(async () => {
    useMarketplaceFeatures('verified');
    api = await createTestApi('test_mode', { signUp: { mode: 'invite', ownerEmail: OWNER } });
    owner = await api.signIn(OWNER);
    ownerAccount = (await api.tenantOf(OWNER)).accountId;
  });

  afterAll(async () => {
    await api.close();
    useMarketplaceFeatures('all');
  });

  /** A customer: invited by the owner, in an account of their own. */
  async function customer() {
    people += 1;
    const email = `customer.${String(people)}@example.com`;
    const invite = await api.call('createInvite', { token: owner, body: {} });
    expect(invite.status).toBe(201);
    const redeemed = await api.call('redeemInvite', {
      body: { code: invite.body.code, email },
      headers: { 'x-forwarded-for': `198.51.100.${String(people)}` },
    });
    expect(redeemed.status).toBe(200);
    const token = await api.signIn(email);
    const { accountId } = await api.tenantOf(email);
    return { token, accountId, email };
  }

  async function setTestMode(token: string, on: boolean) {
    return api.call('setTestMode', { token, body: { on } });
  }

  /** A connection linked on the phone, and a live listing of a new item under it. */
  async function liveListing(
    token: string,
    accountId: string,
    marketplace: Marketplace,
    readOnly = false,
  ) {
    // One connection per marketplace: a later listing there reuses it.
    const existing = await api.db
      .selectFrom('marketplace_connection')
      .select('id')
      .where('account_id', '=', accountId)
      .where('marketplace', '=', marketplace)
      .executeTakeFirst();
    const connection =
      existing ??
      (await api.db
        .insertInto('marketplace_connection')
        .values({
          account_id: accountId,
          marketplace,
          mode: 'automation',
          status: 'connected',
          token_ciphertext: Buffer.from('sealed'),
          runs_on: 'phone',
          read_only: readOnly,
        })
        .returning('id')
        .executeTakeFirstOrThrow());
    const created = await api.call('createItem', {
      token,
      body: { details: { title: 'Wool scarf', listPrice: { amountCents: 4000, currency: 'USD' } } },
    });
    expect(created.status).toBe(201);
    const listing = await api.db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: created.body.id,
        connection_id: connection.id,
        marketplace,
        status: 'active',
        title: 'Wool scarf',
        description: 'Soft and warm.',
        price_cents: 4000,
        external_url: `https://www.${marketplace}.com/products/scarf-${String((listings += 1))}/`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { connectionId: connection.id, listingId: listing.id, itemId: created.body.id };
  }

  /** A processed photo on the item, which a marketplace needs before Listora sends a change. */
  async function addPhoto(token: string, email: string, itemId: string) {
    const uploadFileId = await api.uploads.add(await api.tenantOf(email), {
      bytes: new Uint8Array(
        await sharp({
          create: { width: 640, height: 480, channels: 3, background: { r: 120, g: 90, b: 60 } },
        })
          .jpeg({ quality: 80 })
          .toBuffer(),
      ),
    });
    const added = await api.call('addItemPhoto', {
      token,
      params: { itemId },
      body: { uploadFileId, role: 'front', width: 640, height: 480 },
    });
    expect(added.status).toBe(201);
    await api.photoJobs.runAll();
  }

  const variant = {
    title: 'Wool scarf, red',
    description: 'Soft and warm.',
    price: { amountCents: 4000, currency: 'USD' },
  } as const;

  async function operations(accountId: string) {
    return api.db
      .selectFrom('marketplace_operation')
      .select('kind')
      .where('account_id', '=', accountId)
      .execute();
  }

  it('never shows a customer Test mode or a hidden feature, and refuses to turn it on', async () => {
    const { token, accountId } = await customer();
    const listed = await api.call('listMarketplaceFeatures', { token });
    expect(listed.status).toBe(200);
    expect(listed.body.testMode).toBeUndefined();
    expect(listed.body.data.every((entry) => entry.testing === undefined)).toBe(true);
    expect(listed.body.data.find((entry) => entry.marketplace === 'poshmark')?.features).toEqual(
      [],
    );
    const refused = await setTestMode(token, true);
    expect(refused.status).toBe(404);
    const account = await api.db
      .selectFrom('account')
      .select('test_mode')
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    expect(account.test_mode).toBe(false);
  });

  it('gives a customer nothing of a flag left on, and turns it off', async () => {
    const { token, accountId } = await customer();
    await api.db
      .updateTable('account')
      .set({ test_mode: true })
      .where('id', '=', accountId)
      .execute();
    const listed = await api.call('listMarketplaceFeatures', { token });
    expect(listed.body.testMode).toBeUndefined();
    expect(listed.body.data.find((entry) => entry.marketplace === 'poshmark')?.features).toEqual(
      [],
    );
    const account = await api.db
      .selectFrom('account')
      .select('test_mode')
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    expect(account.test_mode).toBe(false);
    // So the listing's revise stays hidden too.
    const { listingId } = await liveListing(token, accountId, 'depop');
    const listing = await api.call('getListing', { token, params: { listingId } });
    expect(listing.body.availableActions.map((entry) => entry.action)).not.toContain('revise');
  });

  it('shows the owner the switch, off by default, and every built feature once it is on', async () => {
    const before = await api.call('listMarketplaceFeatures', { token: owner });
    expect(before.body.testMode).toEqual({ on: false });
    expect(before.body.data.find((entry) => entry.marketplace === 'poshmark')?.features).toEqual(
      [],
    );

    const turned = await setTestMode(owner, true);
    expect(turned.status).toBe(200);
    expect(turned.body.testMode).toEqual({ on: true });
    const depop = turned.body.data.find((entry) => entry.marketplace === 'depop');
    expect(depop?.features).toEqual([...MARKETPLACE_FEATURES]);
    // The verified ones are not tagged; the rest are.
    expect(depop?.testing).toEqual(['offer_answers', 'revise', 'market_comps']);
    const poshmark = turned.body.data.find((entry) => entry.marketplace === 'poshmark');
    expect(poshmark?.testing).toEqual([...MARKETPLACE_FEATURES]);
    // Listora's own hidden features too, the thrift scan among them.
    expect(turned.body.app).toEqual({ features: ['thrift_scan'], testing: ['thrift_scan'] });

    const listed = await api.call('listMarketplaceFeatures', { token: owner });
    expect(listed.body).toEqual(turned.body);

    const off = await setTestMode(owner, false);
    expect(off.body.testMode).toEqual({ on: false });
    expect(off.body.data.every((entry) => entry.testing === undefined)).toBe(true);
    expect(off.body.app).toEqual({ features: [] });
  });

  it('gives a granted account exactly what the owner gets, until the grant is revoked', async () => {
    const tester = await customer();
    const grant = async (at: Date | null) =>
      api.db
        .updateTable('account')
        .set(
          at === null
            ? { test_mode_granted_at: null, test_mode: false }
            : { test_mode_granted_at: at },
        )
        .where('id', '=', tester.accountId)
        .execute();
    await grant(new Date());

    const before = await api.call('listMarketplaceFeatures', { token: tester.token });
    expect(before.body.testMode).toEqual({ on: false });
    const turned = await setTestMode(tester.token, true);
    expect(turned.status).toBe(200);
    const ownerOn = await setTestMode(owner, true);
    try {
      expect(turned.body).toEqual(ownerOn.body);
    } finally {
      await setTestMode(owner, false);
    }
    // Its own hidden feature is offered and queued for it.
    const { itemId, listingId } = await liveListing(tester.token, tester.accountId, 'depop');
    await addPhoto(tester.token, tester.email, itemId);
    const listing = await api.call('getListing', { token: tester.token, params: { listingId } });
    expect(listing.body.availableActions.map((entry) => entry.action)).toContain('revise');

    // Revoked (the admin command clears the grant and the switch): no Test mode again.
    await grant(null);
    const after = await api.call('listMarketplaceFeatures', { token: tester.token });
    expect(after.body.testMode).toBeUndefined();
    expect(after.body.data.every((entry) => entry.testing === undefined)).toBe(true);
    expect((await setTestMode(tester.token, true)).status).toBe(404);
  });

  it('accepts a hidden feature from the owner in Test mode, and from no one else', async () => {
    const someone = await customer();
    const theirs = await liveListing(someone.token, someone.accountId, 'depop');
    await setTestMode(owner, true);
    try {
      const mine = await liveListing(owner, ownerAccount, 'depop');
      await addPhoto(owner, OWNER, mine.itemId);
      const listing = await api.call('getListing', {
        token: owner,
        params: { listingId: mine.listingId },
      });
      expect(listing.body.availableActions.map((entry) => entry.action)).toContain('revise');
      const revised = await api.call('reviseListing', {
        token: owner,
        params: { listingId: mine.listingId },
        body: { variant },
      });
      expect(revised.status).toBe(202);
      expect((await operations(ownerAccount)).map((op) => op.kind)).toContain('revise');

      // The owner's Test mode is the owner's alone: the customer's revise is still refused.
      const refused = await api.call('reviseListing', {
        token: someone.token,
        params: { listingId: theirs.listingId },
        body: { variant },
      });
      expect(refused.status).toBe(409);
      expect(refused.error).toMatchObject({ code: 'marketplace_action_unavailable' });
      expect(await operations(someone.accountId)).toEqual([]);

      // A sync reads Poshmark's hidden checks for the owner, never for the customer.
      await liveListing(owner, ownerAccount, 'poshmark');
      await liveListing(someone.token, someone.accountId, 'poshmark');
      expect((await api.call('requestSync', { token: owner })).status).toBe(200);
      expect((await api.call('requestSync', { token: someone.token })).status).toBe(200);
      const work = async (accountId: string) =>
        (
          await api.db
            .selectFrom('phone_work')
            .select(['marketplace', 'purpose'])
            .where('account_id', '=', accountId)
            .where('marketplace', '=', 'poshmark')
            .orderBy('purpose')
            .execute()
        ).map((row) => row.purpose);
      expect(await work(ownerAccount)).toEqual(
        expect.arrayContaining(['offer_check', 'sale_check']),
      );
      expect(await work(someone.accountId)).toEqual([]);
    } finally {
      await setTestMode(owner, false);
    }
  });

  it('keeps a read-only connection read-only in Test mode', async () => {
    await setTestMode(owner, true);
    try {
      const { listingId, connectionId } = await liveListing(owner, ownerAccount, 'mercari', true);
      const before = (await operations(ownerAccount)).length;
      const listing = await api.call('getListing', { token: owner, params: { listingId } });
      const actions = listing.body.availableActions.map((entry) => entry.action);
      expect(actions).not.toContain('revise');
      expect(actions).not.toContain('change_price');
      const refused = await api.call('reviseListing', {
        token: owner,
        params: { listingId },
        body: { variant },
      });
      expect(refused.status).toBe(409);
      expect(refused.error).toMatchObject({ code: 'connection_read_only' });
      expect((await operations(ownerAccount)).length).toBe(before);

      // Its offers show, with no answers, and an answer is refused.
      const offer = await api.db
        .insertInto('marketplace_offer')
        .values({
          account_id: ownerAccount,
          connection_id: connectionId,
          marketplace: 'mercari',
          external_offer_id: 'offer-read-only',
          listing_title: 'Wool scarf',
          amount_cents: 3000,
          list_price_cents: 4000,
          buyer_name: 'scarffan',
          offer_url: 'https://www.mercari.com/offers/1/',
          expires_at: new Date(Date.now() + 3_600_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const answered = await api.call('answerOffer', {
        token: owner,
        params: { offerId: offer.id },
        body: { action: 'accept', offerAmount: { amountCents: 3000, currency: 'USD' } },
      });
      expect(answered.status).toBe(409);
      const responses = await api.db
        .selectFrom('offer_response')
        .select('id')
        .where('offer_id', '=', offer.id)
        .execute();
      expect(responses).toEqual([]);
    } finally {
      await setTestMode(owner, false);
    }
  });

  it('records each run of a hidden feature in the owner’s log, and nothing else', async () => {
    const someone = await customer();
    const { connectionId } = await liveListing(owner, ownerAccount, 'poshmark');
    const theirs = await liveListing(someone.token, someone.accountId, 'poshmark');
    const depop = await liveListing(owner, ownerAccount, 'depop');
    const runs = async (accountId: string) =>
      (
        await api.db
          .selectFrom('feature_test_run')
          .select(['marketplace', 'feature', 'outcome', 'error_code', 'detail'])
          .where('account_id', '=', accountId)
          .orderBy('created_at')
          .orderBy('id')
          .execute()
      ).map((row) => ({ ...row }));
    const before = (await runs(ownerAccount)).length;

    // Out of Test mode nothing is a test.
    await recordReadSucceeded(api.db, {
      accountId: ownerAccount,
      connectionId,
      marketplace: 'poshmark',
      read: 'offer_check',
    });
    expect((await runs(ownerAccount)).length).toBe(before);

    await setTestMode(owner, true);
    try {
      await recordReadFailed(
        api.db,
        { accountId: ownerAccount, connectionId, marketplace: 'poshmark', read: 'offer_check' },
        { code: 'element_missing', step: 'read the offers', detail: 'no offer rows' },
      );
      await recordReadSucceeded(api.db, {
        accountId: ownerAccount,
        connectionId,
        marketplace: 'poshmark',
        read: 'sale_check',
      });
      // Depop's offers passed live: a verified read is no test.
      await recordReadSucceeded(api.db, {
        accountId: ownerAccount,
        connectionId: depop.connectionId,
        marketplace: 'depop',
        read: 'offer_check',
      });
      // A customer's run is never recorded, Test mode or not.
      expect(
        await recordFeatureTestRun(api.db, {
          accountId: someone.accountId,
          marketplace: 'poshmark',
          feature: 'offers',
          outcome: 'passed',
          subjectId: theirs.connectionId,
        }),
      ).toBe(false);
      expect((await runs(ownerAccount)).slice(before)).toEqual([
        {
          marketplace: 'poshmark',
          feature: 'offers',
          outcome: 'failed',
          error_code: 'element_missing',
          detail: 'read the offers: no offer rows',
        },
        {
          marketplace: 'poshmark',
          feature: 'sale_checks',
          outcome: 'passed',
          error_code: null,
          detail: null,
        },
      ]);
      expect(await runs(someone.accountId)).toEqual([]);
    } finally {
      await setTestMode(owner, false);
    }
  });
});
