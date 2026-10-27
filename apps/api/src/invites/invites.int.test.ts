import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';
import { MAX_FAILED_REDEMPTIONS } from './limiter.ts';

const OWNER = 'antonio.jenkins@example.com';
const MARIA = 'maria.lopez@example.com';
const DAY_MS = 86_400_000;

/**
 * Invite-based sign-up against a real Postgres, with the `invite` sign-up policy of the
 * personal environment: the owner signs up directly, everyone else only through an invite.
 * The dev driver stands in for Cognito's emailed codes, and the fake directory for the pool.
 */
describe('invites (real Postgres)', () => {
  let api: TestApi;
  let owner: string;

  beforeAll(async () => {
    api = await createTestApi('invites', { signUp: { mode: 'invite', ownerEmail: OWNER } });
    owner = await api.signIn(OWNER);
  });

  afterAll(async () => {
    await api.close();
  });

  beforeEach(() => {
    api.invitees.failWith = undefined;
    api.invitees.unverified.clear();
  });

  let people = 0;
  /** A new invitee address for each test, so tests do not share invites. */
  const someone = () => `person.${String((people += 1))}@example.com`;

  async function invite(body: { label?: string; expiresInDays?: number } = {}) {
    const created = await api.call('createInvite', { token: owner, body });
    expect(created.status).toBe(201);
    return created.body;
  }

  function redeem(code: string, email: string) {
    return api.call('redeemInvite', { body: { code, email } });
  }

  async function inviteState(id: string, token = owner) {
    const listed = await api.call('listInvites', { token });
    const found = listed.body.data.find((entry) => entry.id === id);
    if (!found) throw new Error(`invite ${id} is not listed`);
    return found;
  }

  /** Invites, redeems, and signs the invitee in: their token, and their first request done. */
  async function join(email: string) {
    const { code, invite: created } = await invite({ label: 'Maria' });
    expect((await redeem(code, email)).status).toBe(200);
    const token = await api.signIn(email);
    expect((await api.call('listItems', { token })).status).toBe(200);
    return { token, inviteId: created.id };
  }

  describe('signing up', () => {
    it('lets the owner sign up without an invite, and invite others', async () => {
      expect((await api.call('listItems', { token: owner })).status).toBe(200);
      const listed = await api.call('listInvites', { token: owner });
      expect(listed.status).toBe(200);
      expect(listed.body.canInvite).toBe(true);
    });

    it('refuses an account to anyone else who has no invite', async () => {
      const stranger = 'stranger@example.com';
      const token = await api.signIn(stranger);
      const refused = await api.call('listItems', { token });
      expect(refused.status).toBe(403);
      expect(refused.error.message).toMatch(/invite-only/);
      const users = await api.db
        .selectFrom('app_user')
        .select('id')
        .where('email', '=', stranger)
        .execute();
      expect(users).toEqual([]);
    });

    it('creates an invite with a one-time code, a link, and a message to share', async () => {
      const created = await invite({ label: 'Maria', expiresInDays: 7 });
      expect(created.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
      expect(created.link).toBe(`listora://invite/${created.code}`);
      expect(created.message).toContain(created.code);
      expect(created.message).toMatch(/^Hi Maria! /);
      expect(created.invite).toMatchObject({
        label: 'Maria',
        codeHint: created.code.slice(-4),
        status: 'open',
        statusDisplay: { label: 'Not used yet' },
        availableActions: ['revoke'],
      });
      expect(Date.parse(created.invite.expiresAt ?? '')).toBeGreaterThan(api.clock.now);
      // Only the hash is stored.
      const row = await api.db
        .selectFrom('account_invite')
        .selectAll()
        .where('id', '=', created.invite.id)
        .executeTakeFirstOrThrow();
      expect(JSON.stringify(row)).not.toContain(created.code.replaceAll('-', ''));
    });

    it('signs an invitee up with their own email into their own, new account', async () => {
      const { code, invite: created } = await invite({ label: 'Maria' });
      const redeemed = await redeem(code.toLowerCase().replaceAll('-', ' '), MARIA.toUpperCase());
      expect(redeemed.status).toBe(200);
      expect(redeemed.body).toMatchObject({ email: MARIA, status: 'ready' });
      expect(redeemed.headers['cache-control']).toBe('no-store');
      expect(api.invitees.admitted.has(MARIA)).toBe(true);
      expect(await inviteState(created.id)).toMatchObject({
        status: 'redeemed',
        email: MARIA,
        availableActions: ['revoke'],
      });

      const maria = await api.signIn(MARIA);
      expect((await api.call('listItems', { token: maria })).status).toBe(200);
      const state = await inviteState(created.id);
      expect(state).toMatchObject({
        status: 'active',
        email: MARIA,
        statusDisplay: { label: 'Active' },
      });
      expect(state.joinedAt).toBeDefined();

      const ownerTenant = await api.tenantOf(OWNER);
      const mariaTenant = await api.tenantOf(MARIA);
      expect(mariaTenant.accountId).not.toBe(ownerTenant.accountId);
      expect(mariaTenant.role).toBe('owner');
      // An invited person cannot invite in turn.
      const hers = await api.call('listInvites', { token: maria });
      expect(hers.body).toEqual({ canInvite: false, data: [] });
      const refused = await api.call('createInvite', { token: maria, body: {} });
      expect(refused.status).toBe(403);
    });

    it('answers a repeated redemption the same way', async () => {
      const email = someone();
      const { code } = await invite();
      const first = await redeem(code, email);
      const again = await redeem(code, email);
      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
      const joined = await api.signIn(email);
      expect((await api.call('listItems', { token: joined })).status).toBe(200);
      expect((await redeem(code, email)).body).toEqual(first.body);
    });

    it('moves a redeemed invite to a corrected email until the invitee signs in', async () => {
      const typo = someone();
      const right = someone();
      const { code, invite: created } = await invite();
      await redeem(code, typo);
      const moved = await redeem(code, right);
      expect(moved.status).toBe(200);
      expect(moved.body.email).toBe(right);
      expect(api.invitees.calls).toContain(`forget ${typo}`);
      expect(api.invitees.admitted.has(typo)).toBe(false);
      expect((await inviteState(created.id)).email).toBe(right);
      // The old address got nothing: it signs in to no account.
      expect((await api.call('listItems', { token: await api.signIn(typo) })).status).toBe(403);

      const token = await api.signIn(right);
      expect((await api.call('listItems', { token })).status).toBe(200);
      const late = await redeem(code, someone());
      expect(late.status).toBe(409);
      expect(late.error.code).toBe('invalid_state_transition');
    });

    it('limits how often the email moves', async () => {
      const { code } = await invite();
      for (let change = 0; change <= 5; change += 1) {
        expect((await redeem(code, someone())).status, `change ${String(change)}`).toBe(200);
      }
      const refused = await redeem(code, someone());
      expect(refused.status).toBe(409);
      expect(refused.error.message).toMatch(/changed too many times/);
    });

    it('refuses an email that already has a Listora account', async () => {
      const { code } = await invite();
      for (const email of [OWNER, MARIA]) {
        const refused = await redeem(code, email);
        expect(refused.status, email).toBe(409);
        expect(refused.error.code, email).toBe('already_exists');
      }
      // The invite is still unused.
      const fresh = someone();
      expect((await redeem(code, fresh)).body.email).toBe(fresh);
    });

    it("says when the address must be verified first (SES's sandbox)", async () => {
      const email = someone();
      api.invitees.unverified.add(email);
      const { code } = await invite();
      const waiting = await redeem(code, email);
      expect(waiting.status).toBe(200);
      expect(waiting.body.status).toBe('email_verification_sent');
      expect(waiting.body.message).toMatch(/Amazon Web Services emailed/);
      api.invitees.unverified.delete(email);
      expect((await redeem(code, email)).body.status).toBe('ready');
    });

    it('changes nothing it cannot finish at the provider, and redeems on a retry', async () => {
      const email = someone();
      const { code } = await invite();
      api.invitees.failWith = new Error('Cognito is down');
      const failed = await redeem(code, email);
      expect(failed.status).toBe(503);
      expect(failed.error.retryable).toBe(true);
      api.invitees.failWith = undefined;
      expect((await redeem(code, email)).body.status).toBe('ready');
      expect(api.invitees.admitted.has(email)).toBe(true);
    });

    it('refuses codes that are wrong or malformed', async () => {
      const wrong = await redeem('ZZZZ-ZZZZ-ZZZZ-ZZZZ', someone());
      expect(wrong.status).toBe(404);
      const malformed = await redeem('not a code', someone());
      expect(malformed.status).toBe(422);
      expect(fieldsOf(malformed)).toEqual(['code']);
      const noEmail = await api.call('redeemInvite', { body: { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' } });
      expect(noEmail.status).toBe(422);
    });

    it('limits the open invites an account has', async () => {
      const { count } = await api.db
        .selectFrom('account_invite')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('claimed_email', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirstOrThrow();
      for (let open = count; open < 20; open += 1) await invite();
      const refused = await api.call('createInvite', { token: owner, body: {} });
      expect(refused.status).toBe(409);
      // Revoking one makes room.
      const listed = await api.call('listInvites', { token: owner });
      const first = listed.body.data.find((entry) => entry.status === 'open');
      await api.call('revokeInvite', { token: owner, params: { inviteId: first?.id ?? '' } });
      expect((await api.call('createInvite', { token: owner, body: {} })).status).toBe(201);
      // Leave room for the rest of the tests.
      for (const entry of (await api.call('listInvites', { token: owner })).body.data) {
        if (entry.status === 'open') {
          await api.call('revokeInvite', { token: owner, params: { inviteId: entry.id } });
        }
      }
    });
  });

  describe('expiry', () => {
    it('stops an invite nobody redeemed in time', async () => {
      const { code, invite: created } = await invite({ expiresInDays: 1 });
      const start = api.clock.now;
      try {
        api.clock.now = start + DAY_MS + 1_000;
        const expired = await redeem(code, someone());
        expect(expired.status).toBe(409);
        expect(expired.error.message).toMatch(/expired/);
        // A day later, the owner's dev session has ended too.
        expect(await inviteState(created.id, await api.signIn(OWNER))).toMatchObject({
          status: 'expired',
          availableActions: [],
        });
      } finally {
        api.clock.now = start;
      }
    });

    it('does not expire an invite once it was redeemed', async () => {
      const email = someone();
      const { code } = await invite({ expiresInDays: 1 });
      await redeem(code, email);
      const start = api.clock.now;
      try {
        api.clock.now = start + 2 * DAY_MS;
        expect((await redeem(code, email)).status).toBe(200);
        const token = await api.signIn(email);
        expect((await api.call('listItems', { token })).status).toBe(200);
      } finally {
        api.clock.now = start;
      }
    });
  });

  describe('revocation', () => {
    it('stops an invite before anyone redeems it', async () => {
      const { code, invite: created } = await invite();
      const revoked = await api.call('revokeInvite', {
        token: owner,
        params: { inviteId: created.id },
      });
      expect(revoked.status).toBe(200);
      expect(revoked.body).toMatchObject({ status: 'revoked', availableActions: [] });
      const refused = await redeem(code, someone());
      expect(refused.status).toBe(409);
      expect(refused.error.message).toMatch(/turned off/);
      const restore = await api.call('restoreInvite', {
        token: owner,
        params: { inviteId: created.id },
      });
      expect(restore.status).toBe(409);
    });

    it("removes a person's access at once, keeps their data, and gives it back", async () => {
      const email = someone();
      const { token, inviteId } = await join(email);
      const item = await api.call('createItem', {
        token,
        body: { details: { title: 'Wool coat' } },
      });
      expect(item.status).toBe(201);

      const revoked = await api.call('revokeInvite', { token: owner, params: { inviteId } });
      expect(revoked.body).toMatchObject({
        status: 'revoked',
        email,
        statusDisplay: { label: 'Access turned off' },
        availableActions: ['restore'],
      });
      expect(api.invitees.suspended.has(email)).toBe(true);
      // Their token still verifies, but the API refuses it.
      const refused = await api.call('listItems', { token });
      expect(refused.status).toBe(403);
      expect(refused.error.message).toMatch(/turned off/);
      // Revoking again changes nothing.
      expect((await api.call('revokeInvite', { token: owner, params: { inviteId } })).status).toBe(
        200,
      );

      const restored = await api.call('restoreInvite', { token: owner, params: { inviteId } });
      expect(restored.body).toMatchObject({ status: 'active', availableActions: ['revoke'] });
      expect(api.invitees.suspended.has(email)).toBe(false);
      const back = await api.call('getItem', { token, params: { itemId: item.body.id } });
      expect(back.status).toBe(200);
      expect(back.body.details.title).toBe('Wool coat');
    });

    it('refuses an account to someone revoked before their first sign-in', async () => {
      const email = someone();
      const { code, invite: created } = await invite();
      await redeem(code, email);
      await api.call('revokeInvite', { token: owner, params: { inviteId: created.id } });
      expect(api.invitees.suspended.has(email)).toBe(true);
      const token = await api.signIn(email);
      expect((await api.call('listItems', { token })).status).toBe(403);
      const accounts = await api.db
        .selectFrom('account')
        .select('id')
        .where('name', '=', email)
        .execute();
      expect(accounts).toEqual([]);
    });

    it('revokes nothing when the sign-in provider fails, and does on a retry', async () => {
      const email = someone();
      const { token, inviteId } = await join(email);
      api.invitees.failWith = new Error('Cognito is down');
      const failed = await api.call('revokeInvite', { token: owner, params: { inviteId } });
      expect(failed.status).toBe(503);
      expect(failed.error.retryable).toBe(true);
      expect((await inviteState(inviteId)).status).toBe('active');
      expect((await api.call('listItems', { token })).status).toBe(200);

      api.invitees.failWith = undefined;
      expect((await api.call('revokeInvite', { token: owner, params: { inviteId } })).status).toBe(
        200,
      );
      expect((await api.call('listItems', { token })).status).toBe(403);
    });

    it("cannot touch another account's invites", async () => {
      const email = someone();
      const { token: theirs } = await join(email);
      const { invite: created } = await invite();
      for (const operation of ['revokeInvite', 'restoreInvite'] as const) {
        const refused = await api.call(operation, {
          token: theirs,
          params: { inviteId: created.id },
        });
        expect(refused.status, operation).toBe(404);
      }
      expect((await inviteState(created.id)).status).toBe('open');
    });
  });

  describe('separate accounts', () => {
    it("keeps each account's inventory, sales, and settings to itself", async () => {
      const email = someone();
      const { token: theirs } = await join(email);
      const ownerItem = await api.call('createItem', {
        token: owner,
        body: { details: { title: "Owner's jacket" } },
      });
      const theirItem = await api.call('createItem', {
        token: theirs,
        body: { details: { title: 'Their boots' } },
      });
      expect(theirItem.body.sku.split('-')[0]).toBe('PE');

      const ownerItems = await api.call('listItems', { token: owner });
      const theirItems = await api.call('listItems', { token: theirs });
      expect(ownerItems.body.data.map((item) => item.id)).toContain(ownerItem.body.id);
      expect(ownerItems.body.data.map((item) => item.id)).not.toContain(theirItem.body.id);
      expect(theirItems.body.data.map((item) => item.id)).toEqual([theirItem.body.id]);

      for (const [token, itemId] of [
        [theirs, ownerItem.body.id],
        [owner, theirItem.body.id],
      ] as const) {
        expect((await api.call('getItem', { token, params: { itemId } })).status).toBe(404);
        const changed = await api.call('replaceItem', {
          token,
          params: { itemId },
          body: { expectedVersion: 1, details: { title: 'Taken over' } },
        });
        expect(changed.status).toBe(404);
      }
      expect((await api.call('listSales', { token: theirs })).body.data).toEqual([]);
      expect((await api.call('listConnections', { token: theirs })).status).toBe(200);
      const theirProfile = await api.call('getProfile', { token: theirs });
      expect(theirProfile.status).toBe(200);
      expect(theirProfile.body.email).toBe(email);
    });

    it("counts each account's AI spend against its own daily budget", async () => {
      const ownerTenant = await api.tenantOf(OWNER);
      const email = someone();
      await join(email);
      const theirs = await api.tenantOf(email);
      // A whole day's budget spent by the owner's account leaves the invitee's untouched.
      await api.db
        .insertInto('ai_usage_daily')
        .values({
          account_id: ownerTenant.accountId,
          usage_date: new Date().toISOString().slice(0, 10),
          cost_micros: 5_000_000,
        })
        .execute();
      const guard = (accountId: string) =>
        api.ai.checkGuards({ accountId, tier: 'standard', purpose: 'item_analysis' });
      await expect(guard(theirs.accountId)).resolves.toBeUndefined();
      await expect(guard(ownerTenant.accountId)).rejects.toThrow(/budget/i);
    });

    it("deletes the invitee's invite and their provider user with their account", async () => {
      const email = someone();
      const { token, inviteId } = await join(email);
      const deleted = await api.call('deleteAccount', { token });
      expect(deleted.status).toBe(200);
      const listed = await api.call('listInvites', { token: owner });
      expect(listed.body.data.map((entry) => entry.id)).not.toContain(inviteId);
      expect(api.invitees.calls).toContain(`forget ${email}`);
      const rows = await api.db
        .selectFrom('account_invite')
        .select('id')
        .where('claimed_email', '=', email)
        .execute();
      expect(rows).toEqual([]);
    });
  });

  // Last: the limit holds for the rest of the API process.
  it('limits wrong codes', async () => {
    const { code } = await invite();
    let wrong = 0;
    let limited = await redeem('ZZZZ-ZZZZ-ZZZZ-ZZZY', someone());
    while (limited.status === 404 && wrong <= MAX_FAILED_REDEMPTIONS) {
      wrong += 1;
      limited = await redeem('ZZZZ-ZZZZ-ZZZZ-ZZZY', someone());
    }
    expect(limited.status).toBe(429);
    expect(limited.error.retryAfterSeconds).toBeGreaterThan(0);
    // Even a right code waits.
    expect((await redeem(code, someone())).status).toBe(429);
    const start = api.clock.now;
    try {
      api.clock.now = start + 16 * 60_000;
      expect((await redeem(code, someone())).status).toBe(200);
    } finally {
      api.clock.now = start;
    }
  });
});
