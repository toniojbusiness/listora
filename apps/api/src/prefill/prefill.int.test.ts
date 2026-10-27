import { MARKETPLACE_PREFILL_OUTPUT_NAME } from '@listora/analysis';
import { createInventoryItem, type Marketplace } from '@listora/db';
import { photoSetHash } from '@listora/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';

const OWNER = 'prefill.owner@example.com';
const STRANGER = 'prefill.stranger@example.com';
/** The items have no photos, so the fake AI answers them all by the empty photo set. */
const NO_PHOTOS = photoSetHash([]);
const LEGO = 'Toys & Collectibles > Building Toys > LEGO Toys';

describe('the marketplace pre-fill (real Postgres)', () => {
  let api: TestApi;
  let token: string;

  beforeAll(async () => {
    api = await createTestApi('prefill');
    token = await api.signIn(OWNER);
    const tenant = await api.tenantOf(OWNER);
    for (const marketplace of ['depop', 'mercari'] satisfies Marketplace[]) {
      await api.db
        .insertInto('marketplace_connection')
        .values({
          account_id: tenant.accountId,
          marketplace,
          mode: 'automation',
          status: 'connected',
          token_ciphertext: Buffer.from('sealed'),
          runs_on: 'phone',
        })
        .execute();
    }
  });

  afterAll(async () => {
    await api.close();
  });

  beforeEach(() => {
    api.aiControls.killed = false;
    for (const key of Object.keys(api.aiControls.fixtures)) {
      Reflect.deleteProperty(api.aiControls.fixtures, key);
    }
  });

  async function item(details: Parameters<typeof createInventoryItem>[2]) {
    const tenant = await api.tenantOf(OWNER);
    return (
      await createInventoryItem(api.db, tenant.accountId, {
        condition: 'pre_owned_good',
        ...details,
      })
    ).id;
  }

  function aiAnswers(picks: unknown, extra: Record<string, unknown> = {}) {
    api.aiControls.fixtures[NO_PHOTOS] = {
      outputs: { [MARKETPLACE_PREFILL_OUTPUT_NAME]: { picks } },
      ...extra,
    };
  }

  async function aiCalls(itemId: string) {
    return api.db
      .selectFrom('ai_usage_event')
      .select(['purpose', 'outcome', 'cost_micros'])
      .where('item_id', '=', itemId)
      .execute();
  }

  async function prefill(itemId: string, query: Record<string, string> = {}) {
    const result = await api.call('getItemMarketplacePrefill', {
      token,
      params: { itemId },
      query,
    });
    expect(result.status).toBe(200);
    return result.body;
  }

  function fieldOf(body: Awaited<ReturnType<typeof prefill>>, marketplace: string, key: string) {
    const found = body.marketplaces
      .find((entry) => entry.marketplace === marketplace)
      ?.fields.find((entry) => entry.key === key);
    if (found === undefined) throw new Error(`no ${marketplace} ${key}`);
    return found;
  }

  it("fills a unisex tee with each marketplace's default, asking nothing and calling no AI", async () => {
    const itemId = await item({
      title: 'Comfort Colors tee',
      category: 'clothing/tops/t_shirts',
      department: 'unisex',
      size_label: 'XL',
      size_system: 'letter',
    });
    const body = await prefill(itemId);
    expect(body.questions).toBe(0);
    const depop = body.marketplaces.find((entry) => entry.marketplace === 'depop');
    expect(depop).toMatchObject({ connected: true, ready: true });
    expect(body.marketplaces.find((entry) => entry.marketplace === 'poshmark')?.connected).toBe(
      false,
    );
    expect(fieldOf(body, 'depop', 'category')).toMatchObject({
      value: { path: ['Men', 'Tops', 'T-shirts'] },
      source: 'default',
      needsAnswer: false,
      options: [{ label: 'Men' }, { label: 'Women' }],
    });
    expect(await aiCalls(itemId)).toEqual([]);

    // The review's unsaved edit decides, before it is saved.
    const edited = await prefill(itemId, { department: 'women' });
    expect(fieldOf(edited, 'depop', 'category').value?.path).toEqual(['Women', 'Tops', 'T-shirts']);
    // A condition Listora doesn't know is none: the review asks for it above.
    const unknown = await prefill(itemId, { condition: 'mint' });
    expect(fieldOf(unknown, 'depop', 'condition').value).toBeUndefined();
    expect(unknown.marketplaces.find((entry) => entry.marketplace === 'depop')?.ready).toBe(false);
  });

  it('asks the AI once for a question Listora cannot settle and keeps its sure pick', async () => {
    const itemId = await item({
      title: 'LEGO Star Wars X-wing building set',
      keywords: ['lego', 'building blocks'],
      category: 'other/other',
      department: 'kids',
    });
    // The pick is the option's number on the list the AI was given; the LEGO one is on it.
    api.aiControls.fixtures[NO_PHOTOS] = { outputs: {} };
    const first = await prefill(itemId);
    // No answer for the fake to give yet: not billed, so it is asked again next time.
    expect(fieldOf(first, 'mercari', 'category').needsAnswer).toBe(true);
    const options = fieldOf(first, 'mercari', 'category').options.map((option) => option.value);
    expect(options).toContain(LEGO);

    aiAnswers([
      { question: 'mercari.category', option: options.indexOf(LEGO) + 1, confidence: 0.95 },
      { question: 'depop.category', option: 1, confidence: 0.4 },
    ]);
    const body = await prefill(itemId);
    expect(fieldOf(body, 'mercari', 'category')).toMatchObject({
      value: { value: LEGO },
      source: 'ai',
      needsAnswer: false,
    });
    // Unsure on Depop: one tap, the AI's guess first.
    expect(fieldOf(body, 'depop', 'category').needsAnswer).toBe(true);
    expect(body.questions).toBe(1);
    // Poshmark isn't linked, so its question costs nothing: it is never sent to the AI.
    const calls = await aiCalls(itemId);
    expect(calls.filter((call) => call.outcome === 'succeeded')).toHaveLength(1);
    expect(calls[calls.length - 1]).toMatchObject({ purpose: 'marketplace_prefill' });

    await prefill(itemId);
    expect(await aiCalls(itemId)).toHaveLength(calls.length);
  });

  it("takes the seller's tap, refuses one the marketplace doesn't offer, and lists with it", async () => {
    const itemId = await item({
      title: 'Plush dinosaur toy',
      keywords: ['plush', 'stuffed animal'],
      category: 'other/other',
      department: 'kids',
    });
    aiAnswers([
      { question: 'mercari.category', option: 0, confidence: 0 },
      { question: 'depop.category', option: 0, confidence: 0 },
    ]);
    const open = await prefill(itemId);
    const question = fieldOf(open, 'mercari', 'category');
    expect(question.needsAnswer).toBe(true);
    const chosen = question.options[0]?.value ?? '';

    const refused = await api.call('answerItemMarketplacePrefill', {
      token,
      params: { itemId },
      body: { marketplace: 'mercari', field: 'category', value: 'Kids > Hovercraft', details: {} },
    });
    expect(refused.status).toBe(422);

    const answered = await api.call('answerItemMarketplacePrefill', {
      token,
      params: { itemId },
      body: { marketplace: 'mercari', field: 'category', value: chosen, details: {} },
    });
    expect(answered.status).toBe(200);
    expect(
      answered.body.marketplaces.find((entry) => entry.marketplace === 'mercari'),
    ).toMatchObject({ ready: true });
    expect(fieldOf(answered.body, 'mercari', 'category')).toMatchObject({
      value: { value: chosen },
      source: 'you',
    });

    // The List flow's categories and a new listing follow the answer.
    const categories = await api.call('getItemMarketplaceCategories', {
      token,
      params: { itemId, marketplace: 'mercari' },
    });
    expect(categories.body.suggested?.ref).toBe(chosen);
    await api.db
      .updateTable('inventory_item')
      .set({ list_price_cents: 2000 })
      .where('id', '=', itemId)
      .execute();
    const created = await api.call('createListing', {
      token,
      params: { itemId },
      body: {
        marketplace: 'mercari',
        variant: {
          title: 'Plush dinosaur toy',
          description: 'A soft plush dinosaur in great shape.',
          price: { amountCents: 2000, currency: 'USD' },
        },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.variant?.categoryRef).toBe(chosen);

    // Once the item's category changes, the answer no longer holds and the question is back.
    await api.db
      .updateTable('inventory_item')
      .set({ category: 'other/other', department: 'women' })
      .where('id', '=', itemId)
      .execute();
    expect(fieldOf(await prefill(itemId), 'mercari', 'category').source).not.toBe('you');
  });

  it('asks girls or boys once for a kids item, and the answer settles every marketplace', async () => {
    const itemId = await item({
      title: 'Dinosaur graphic tee',
      category: 'clothing/tops/t_shirts',
      department: 'kids',
      size_label: '8',
      size_system: 'numeric',
    });
    aiAnswers([{ question: 'kids_gender', option: 0, confidence: 0.3 }]);
    const open = await prefill(itemId);
    expect(open.itemFields[0]).toMatchObject({ key: 'kids_gender', needsAnswer: true });
    expect(open.questions).toBe(1);
    const answered = await api.call('answerItemMarketplacePrefill', {
      token,
      params: { itemId },
      body: { field: 'kids_gender', value: 'boys', details: {} },
    });
    expect(answered.status).toBe(200);
    expect(answered.body.questions).toBe(0);
    expect(fieldOf(answered.body, 'mercari', 'category').value?.path).toEqual([
      'Kids',
      'Boys tops & t-shirts',
      'Boys (4+)',
    ]);
    const withMarketplace = await api.call('answerItemMarketplacePrefill', {
      token,
      params: { itemId },
      body: { marketplace: 'depop', field: 'kids_gender', value: 'boys', details: {} },
    });
    expect(withMarketplace.status).toBe(422);
  });

  it('asks the seller, and does not pay again, when a billed AI call fails', async () => {
    const itemId = await item({
      title: 'Vintage lamp',
      category: 'other/other',
      department: null,
    });
    aiAnswers([], {
      error: { code: 'truncated', retryable: false },
      usage: { inputTokens: 800, outputTokens: 40 },
    });
    const body = await prefill(itemId);
    expect(fieldOf(body, 'mercari', 'category').needsAnswer).toBe(true);
    const calls = await aiCalls(itemId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ outcome: 'failed' });
    await prefill(itemId);
    expect(await aiCalls(itemId)).toHaveLength(1);
    expect(api.logLines.some((line) => line['event'] === 'prefill_ai_failed')).toBe(true);
  });

  it('asks the seller while AI is switched off, and tries the AI again once it is back', async () => {
    const itemId = await item({ title: 'Ceramic mug', category: 'other/other', department: null });
    api.aiControls.killed = true;
    const off = await prefill(itemId);
    expect(fieldOf(off, 'mercari', 'category').needsAnswer).toBe(true);
    expect(await aiCalls(itemId)).toEqual([]);
    api.aiControls.killed = false;
    aiAnswers([{ question: 'mercari.category', option: 1, confidence: 0.9 }]);
    const on = await prefill(itemId);
    expect(fieldOf(on, 'mercari', 'category').source).toBe('ai');
  });

  it("never shows another account's item", async () => {
    const itemId = await item({ title: 'Mine', category: 'clothing/tops/t_shirts' });
    const other = await api.call('getItemMarketplacePrefill', {
      token: await api.signIn(STRANGER),
      params: { itemId },
    });
    expect(other.status).toBe(404);
  });
});
