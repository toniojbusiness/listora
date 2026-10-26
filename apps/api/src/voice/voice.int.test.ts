import { VOICE_CORRECTION_OUTPUT_NAME } from '@listora/analysis';
import { photoSetHash, sha256Hex } from '@listora/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';

const OWNER = 'voice.owner@example.com';
const SPENDER = 'voice.spender@example.com';
const STRANGER = 'voice.stranger@example.com';

describe('voice corrections (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let strangerToken: string;
  let seed = 0;

  beforeAll(async () => {
    api = await createTestApi('voice');
    token = await api.signIn(OWNER);
    strangerToken = await api.signIn(STRANGER);
  });

  afterAll(async () => {
    await api.close();
  });

  beforeEach(() => {
    api.aiControls.killed = false;
  });

  /** An item with one processed photo; returns its id and photo-set hash. */
  async function itemWithPhoto(owner = OWNER, ownerToken = token) {
    const itemId = (await api.call('createItem', { token: ownerToken, body: {} })).body.id;
    seed += 1;
    const bytes = new Uint8Array(
      await sharp({
        create: { width: 64, height: 48, channels: 3, background: { r: seed, g: 9, b: 9 } },
      })
        .jpeg()
        .toBuffer(),
    );
    const uploadFileId = await api.uploads.add(await api.tenantOf(owner), { bytes });
    const added = await api.call('addItemPhoto', {
      token: ownerToken,
      params: { itemId },
      body: { uploadFileId, role: 'front', width: 64, height: 48 },
    });
    expect(added.status).toBe(201);
    return { itemId, hash: photoSetHash([sha256Hex(bytes)]) };
  }

  function answer(hash: string, changes: unknown, usage?: { inputTokens: number }) {
    api.aiControls.fixtures[hash] = {
      outputs: { [VOICE_CORRECTION_OUTPUT_NAME]: { changes } },
      ...(usage === undefined ? {} : { usage }),
    };
  }

  async function usageEvents(itemId: string) {
    return api.db
      .selectFrom('ai_usage_event')
      .select(['purpose', 'tier', 'outcome', 'images'])
      .where('item_id', '=', itemId)
      .execute();
  }

  it('proposes canonical changes without touching the item, and meters the call', async () => {
    const { itemId, hash } = await itemWithPhoto();
    answer(hash, [
      { field: 'pattern', value: 'Plaid' },
      { field: 'listPrice', value: '30' },
      { field: 'colors', value: 'chartreuse' },
    ]);
    const before = (await api.call('getItem', { token, params: { itemId } })).body;

    const result = await api.call('interpretVoiceCorrection', {
      token,
      params: { itemId },
      body: { transcript: '  the pattern is plaid and price it at thirty  ' },
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      changes: [
        { field: 'pattern', value: 'plaid' },
        { field: 'listPrice', amount: { amountCents: 3000, currency: 'USD' } },
      ],
    });
    // A proposal only: the item is unchanged until the seller accepts and saves.
    const after = (await api.call('getItem', { token, params: { itemId } })).body;
    expect(after.version).toBe(before.version);
    expect(await usageEvents(itemId)).toEqual([
      { purpose: 'voice_correction', tier: 'standard', outcome: 'succeeded', images: 0 },
    ]);
  });

  it('replays a retry with the same Idempotency-Key instead of paying again', async () => {
    const { itemId, hash } = await itemWithPhoto();
    answer(hash, [{ field: 'brand', value: 'Pendleton' }]);
    const key = '0198f3f0-0000-7000-8000-00000000c0de';
    const request = { token, params: { itemId }, body: { transcript: 'brand Pendleton' } };
    const first = await api.call('interpretVoiceCorrection', { ...request, idempotencyKey: key });
    const second = await api.call('interpretVoiceCorrection', { ...request, idempotencyKey: key });
    expect(second.body).toEqual(first.body);
    expect(await usageEvents(itemId)).toHaveLength(1);
  });

  it('answers with no changes when nothing maps', async () => {
    const { itemId, hash } = await itemWithPhoto();
    answer(hash, []);
    const result = await api.call('interpretVoiceCorrection', {
      token,
      params: { itemId },
      body: { transcript: 'hmm let me think' },
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ changes: [] });
  });

  it("refuses an empty transcript and another account's item", async () => {
    const { itemId, hash } = await itemWithPhoto();
    answer(hash, []);
    const blank = await api.call('interpretVoiceCorrection', {
      token,
      params: { itemId },
      body: { transcript: '   ' },
    });
    expect(blank.status).toBe(422);
    expect(fieldsOf(blank)).toEqual(['transcript']);

    const tooLong = await api.call('interpretVoiceCorrection', {
      token,
      params: { itemId },
      body: { transcript: 'x'.repeat(501) },
    });
    expect(tooLong.status).toBe(422);

    const stranger = await api.call('interpretVoiceCorrection', {
      token: strangerToken,
      params: { itemId },
      body: { transcript: 'brand Pendleton' },
    });
    expect(stranger.status).toBe(404);
    expect(await usageEvents(itemId)).toEqual([]);
  });

  it('is unavailable (and retryable) while AI is switched off, sending nothing', async () => {
    const { itemId, hash } = await itemWithPhoto();
    answer(hash, [{ field: 'brand', value: 'Pendleton' }]);
    api.aiControls.killed = true;
    const result = await api.call('interpretVoiceCorrection', {
      token,
      params: { itemId },
      body: { transcript: 'brand Pendleton' },
    });
    expect(result.status).toBe(503);
    expect(result.error).toMatchObject({ code: 'service_unavailable', retryable: true });
    expect(result.error.message).toContain('on your iPhone');
    expect(await usageEvents(itemId)).toEqual([]);
  });

  it("counts in the daily AI budget and is refused once it's used up", async () => {
    const spenderToken = await api.signIn(SPENDER);
    const { itemId, hash } = await itemWithPhoto(SPENDER, spenderToken);
    // One call billed far above the $1 daily budget.
    answer(hash, [{ field: 'brand', value: 'Pendleton' }], { inputTokens: 20_000_000 });
    const request = { token: spenderToken, params: { itemId }, body: { transcript: 'Pendleton' } };
    expect((await api.call('interpretVoiceCorrection', request)).status).toBe(200);

    const refused = await api.call('interpretVoiceCorrection', request);
    expect(refused.status).toBe(429);
    expect(refused.error).toMatchObject({ code: 'ai_budget_exceeded', retryable: true });
    expect(refused.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(await usageEvents(itemId)).toHaveLength(1);
  });

  it('fails visibly (and retryably) when the model gives an unusable answer', async () => {
    const { itemId, hash } = await itemWithPhoto();
    answer(hash, [{ field: 'era', value: '1990s' }]);
    const result = await api.call('interpretVoiceCorrection', {
      token,
      params: { itemId },
      body: { transcript: "it's from the nineties" },
    });
    expect(result.status).toBe(503);
    expect(result.error).toMatchObject({ code: 'service_unavailable', retryable: true });
    // The failed call was billed, so it is metered.
    expect(await usageEvents(itemId)).toEqual([
      { purpose: 'voice_correction', tier: 'standard', outcome: 'failed', images: 0 },
    ]);
  });
});
