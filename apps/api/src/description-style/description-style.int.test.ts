/**
 * The description style in Settings through the API (real Postgres): Listora's default until the
 * seller saves their own, saving and trimming, going back to the default, refusing a blank style,
 * and who may change it.
 */
import { DEFAULT_DEPOP_DESCRIPTION_STYLE } from '@listora/analysis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';

const OWNER = 'style.owner@example.com';
const OTHER = 'style.other@example.com';
const MEMBER = 'style.member@example.com';

const OWN_STYLE = 'One calm sentence about the piece, then the size and every flaw. No emoji.';

describe('description style (real Postgres)', () => {
  let api: TestApi;
  let token: string;

  beforeAll(async () => {
    api = await createTestApi('description_style');
    token = await api.signIn(OWNER);
  });

  afterAll(async () => {
    await api.close();
  });

  it("starts with Listora's default Depop style", async () => {
    const result = await api.call('getDescriptionStyle', { token });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ depop: DEFAULT_DEPOP_DESCRIPTION_STYLE, depopIsDefault: true });
  });

  it("saves the seller's own style, trimmed, and reads it back", async () => {
    const saved = await api.call('replaceDescriptionStyle', {
      token,
      body: { depop: `  ${OWN_STYLE}\n` },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ depop: OWN_STYLE, depopIsDefault: false });
    const read = await api.call('getDescriptionStyle', { token });
    expect(read.body).toEqual(saved.body);
  });

  it('refuses a blank or too long style and keeps the saved one', async () => {
    const blank = await api.call('replaceDescriptionStyle', { token, body: { depop: ' \n ' } });
    expect(blank.status).toBe(422);
    expect(fieldsOf(blank)).toEqual(['depop']);
    const long = await api.call('replaceDescriptionStyle', {
      token,
      body: { depop: 'x'.repeat(4001) },
    });
    expect(long.status).toBe(422);
    const read = await api.call('getDescriptionStyle', { token });
    expect(read.body).toEqual({ depop: OWN_STYLE, depopIsDefault: false });
  });

  it('goes back to the default when the style is left out, or saved as the default', async () => {
    const reset = await api.call('replaceDescriptionStyle', { token, body: {} });
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ depop: DEFAULT_DEPOP_DESCRIPTION_STYLE, depopIsDefault: true });

    await api.call('replaceDescriptionStyle', { token, body: { depop: OWN_STYLE } });
    const asDefault = await api.call('replaceDescriptionStyle', {
      token,
      body: { depop: DEFAULT_DEPOP_DESCRIPTION_STYLE },
    });
    expect(asDefault.body).toEqual({
      depop: DEFAULT_DEPOP_DESCRIPTION_STYLE,
      depopIsDefault: true,
    });
    const tenant = await api.tenantOf(OWNER);
    const rows = await api.db
      .selectFrom('description_style')
      .select('depop')
      .where('account_id', '=', tenant.accountId)
      .execute();
    expect(rows).toEqual([]);
  });

  it("keeps each account's style to itself", async () => {
    await api.call('replaceDescriptionStyle', { token, body: { depop: OWN_STYLE } });
    const other = await api.signIn(OTHER);
    const theirs = await api.call('getDescriptionStyle', { token: other });
    expect(theirs.body).toEqual({ depop: DEFAULT_DEPOP_DESCRIPTION_STYLE, depopIsDefault: true });
  });

  it('lets a member read the style but not change it', async () => {
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

    const read = await api.call('getDescriptionStyle', { token: memberToken });
    expect(read.body).toEqual({ depop: OWN_STYLE, depopIsDefault: false });
    const refused = await api.call('replaceDescriptionStyle', {
      token: memberToken,
      body: {},
    });
    expect(refused.status).toBe(403);
    expect(refused.error.code).toBe('forbidden');
    const after = await api.call('getDescriptionStyle', { token });
    expect(after.body).toEqual({ depop: OWN_STYLE, depopIsDefault: false });
  });
});
