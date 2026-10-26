/**
 * The profile in Settings through the API (real Postgres): the sign-in email, the person's name,
 * and the account's business name; saving, clearing, trimming, and who may change the business.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';

const OWNER = 'profile.owner@example.com';
const OTHER = 'profile.other@example.com';
const MEMBER = 'profile.member@example.com';

describe('profile (real Postgres)', () => {
  let api: TestApi;
  let token: string;

  beforeAll(async () => {
    api = await createTestApi('profile');
    token = await api.signIn(OWNER);
  });

  afterAll(async () => {
    await api.close();
  });

  it('starts with only the sign-in email', async () => {
    const result = await api.call('getProfile', { token });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ email: OWNER });
  });

  it('saves both names, trimmed, and reads them back', async () => {
    const saved = await api.call('replaceProfile', {
      token,
      body: { displayName: '  Sam Rivera ', businessName: 'Second Spin Vintage  ' },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      email: OWNER,
      displayName: 'Sam Rivera',
      businessName: 'Second Spin Vintage',
    });
    const read = await api.call('getProfile', { token });
    expect(read.body).toEqual(saved.body);

    const tenant = await api.tenantOf(OWNER);
    const account = await api.db
      .selectFrom('account')
      .select(['name', 'business_name'])
      .where('id', '=', tenant.accountId)
      .executeTakeFirstOrThrow();
    // The internal account label stays as it was.
    expect(account).toEqual({ name: OWNER, business_name: 'Second Spin Vintage' });
  });

  it('clears a name the body leaves out', async () => {
    const saved = await api.call('replaceProfile', { token, body: { displayName: 'Sam' } });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ email: OWNER, displayName: 'Sam' });
  });

  it('refuses a blank or too long name and saves nothing', async () => {
    const blank = await api.call('replaceProfile', {
      token,
      body: { displayName: '   ', businessName: 'Kept out' },
    });
    expect(blank.status).toBe(422);
    expect(fieldsOf(blank)).toEqual(['displayName']);

    const long = await api.call('replaceProfile', {
      token,
      body: { businessName: 'x'.repeat(201) },
    });
    expect(long.status).toBe(422);

    const read = await api.call('getProfile', { token });
    expect(read.body).toEqual({ email: OWNER, displayName: 'Sam' });
  });

  it("keeps each person's profile to their own account", async () => {
    const other = await api.signIn(OTHER);
    await api.call('replaceProfile', { token: other, body: { businessName: 'Other Shop' } });
    const mine = await api.call('getProfile', { token });
    expect(mine.body).toEqual({ email: OWNER, displayName: 'Sam' });
    const theirs = await api.call('getProfile', { token: other });
    expect(theirs.body).toEqual({ email: OTHER, businessName: 'Other Shop' });
  });

  it("lets a member change their own name but not the account's business name", async () => {
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

    const refused = await api.call('replaceProfile', {
      token: memberToken,
      body: { displayName: 'Alex', businessName: 'Taken Over' },
    });
    expect(refused.status).toBe(403);
    expect(refused.error.code).toBe('forbidden');

    const ownName = await api.call('replaceProfile', {
      token: memberToken,
      body: { displayName: 'Alex' },
    });
    expect(ownName.status).toBe(200);
    expect(ownName.body).toEqual({ email: MEMBER, displayName: 'Alex' });
    const ownerView = await api.call('getProfile', { token });
    expect(ownerView.body).toEqual({ email: OWNER, displayName: 'Sam' });
  });
});
