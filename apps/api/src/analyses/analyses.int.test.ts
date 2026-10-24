import { randomUUID } from 'node:crypto';

import { PostgresAiControls, PostgresUsageStore } from '@listora/ai';
import {
  encodeAnalysisAnswer,
  ITEM_ANALYSIS_OUTPUT_NAME,
  type ItemAnalysisOutput,
} from '@listora/analysis';
import { photoSetHash, sha256Hex } from '@listora/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Tenant } from '../tenancy.ts';
import { createTestApi, type TestApi } from '../test-support.ts';

const OWNER = 'analysis.owner@example.com';
const STRANGER = 'analysis.stranger@example.com';

/** A small JPEG; `seed` makes each one a different file. */
async function jpeg(seed: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: seed % 256, g: 80, b: 40 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer(),
  );
}

/** A valid analysis answer for an item whose tag photo reads "RN 12345" with a UPC barcode. */
function answer(overrides: Partial<ItemAnalysisOutput> = {}): ItemAnalysisOutput {
  return {
    attributes: {
      brand: { value: 'Patagonia', confidence: 0.95, source: 'tag_text' },
      productName: { value: 'Better Sweater', confidence: 0.8, source: 'photo' },
      styleNumber: null,
      rnNumber: { value: '12345', confidence: 0.9, source: 'tag_text' },
      upc: { value: '036000291452', confidence: 0.95, source: 'barcode' },
      department: { value: 'women', confidence: 0.9, source: 'photo' },
      category: { value: 'clothing/outerwear', confidence: 0.9, source: 'photo' },
      subcategory: { value: 'jackets', confidence: 0.85, source: 'photo' },
      sizeLabel: { value: 'M', confidence: 0.9, source: 'tag_text' },
      sizeSystem: { value: 'letter', confidence: 0.9, source: 'tag_text' },
      colors: { values: ['gray'], confidence: 0.9, source: 'photo' },
      pattern: { value: 'solid', confidence: 0.9, source: 'photo' },
      materials: { values: ['polyester'], confidence: 0.8, source: 'tag_text' },
      condition: { value: 'pre_owned_excellent', confidence: 0.8, source: 'photo' },
      conditionNotes: null,
      flaws: null,
      keywords: { values: ['fleece', 'outdoor'], confidence: 0.7, source: 'photo' },
    },
    title: { value: "Patagonia Better Sweater Fleece Jacket, Women's M", confidence: 0.85 },
    description: { value: 'Gray fleece jacket in excellent condition.', confidence: 0.8 },
    variants: {
      ebay: { title: 'Patagonia Better Sweater Fleece Jacket Womens M Gray', description: 'Gray.' },
      depop: {
        title: 'Patagonia fleece',
        description: 'Cozy gray fleece.',
        hashtags: ['gorpcore'],
      },
      poshmark: { title: 'Patagonia Better Sweater', description: 'Layer it all fall.' },
      mercari: { title: 'Patagonia Better Sweater Jacket M', description: 'Gray fleece jacket.' },
    },
    priceEstimate: { lowCents: 4_000, midCents: 5_500, highCents: 7_000, confidence: 0.6 },
    looksVintage: false,
    looksDesigner: false,
    needsEscalation: false,
    escalationReason: null,
    ...overrides,
  };
}

describe('item analysis (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;
  let strangerToken: string;

  beforeAll(async () => {
    api = await createTestApi('analyses');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
    strangerToken = await api.signIn(STRANGER);
  });

  afterAll(async () => {
    await api.close();
  });

  beforeEach(() => {
    api.aiControls.killed = false;
    api.aiControls.autoEscalate = true;
    api.analysisJobs.jobs.length = 0;
  });

  let seed = 0;

  async function newItem(): Promise<string> {
    return (await api.call('createItem', { token, body: {} })).body.id;
  }

  /** Adds a front photo and a tag photo with phone reads; returns the photo-set hash. */
  async function addPhotos(itemId: string, options: { process?: boolean } = {}) {
    const files: Uint8Array[] = [];
    for (const role of ['front', 'tag'] as const) {
      seed += 1;
      const bytes = await jpeg(seed);
      files.push(bytes);
      const uploadFileId = await api.uploads.add(tenant, { bytes });
      const added = await api.call('addItemPhoto', {
        token,
        params: { itemId },
        body: {
          uploadFileId,
          role,
          width: 640,
          height: 480,
          ...(role === 'tag'
            ? {
                ocrLines: [
                  { text: 'PATAGONIA', confidence: 0.98 },
                  { text: 'RN 12345', confidence: 0.96 },
                  { text: 'SIZE M', confidence: 0.95 },
                ],
                barcodes: [{ symbology: 'upc_a', payload: '036000291452' }],
              }
            : {}),
        },
      });
      expect(added.status).toBe(201);
    }
    if (options.process !== false) await api.photoJobs.runAll();
    return photoSetHash(files.map((bytes) => sha256Hex(bytes)));
  }

  async function analyzedItem(output: ItemAnalysisOutput = answer()) {
    const itemId = await newItem();
    const hash = await addPhotos(itemId);
    api.aiControls.fixtures[hash] = {
      outputs: { [ITEM_ANALYSIS_OUTPUT_NAME]: encodeAnalysisAnswer(output) },
    };
    const started = await api.call('startItemAnalysis', { token, params: { itemId } });
    expect(started.status).toBe(202);
    return { itemId, hash, analysisId: started.body.id };
  }

  async function getAnalysis(analysisId: string) {
    return (await api.call('getAnalysis', { token, params: { analysisId } })).body;
  }

  async function usageEvents(itemId: string) {
    return api.db
      .selectFrom('ai_usage_event')
      .select(['tier', 'outcome', 'error_code', 'purpose', 'user_id', 'model'])
      .where('item_id', '=', itemId)
      .orderBy('id')
      .execute();
  }

  async function quotaUsed(metric: string): Promise<number> {
    const row = await api.db
      .selectFrom('usage_counter')
      .select('used')
      .where('account_id', '=', tenant.accountId)
      .where('metric', '=', metric)
      .executeTakeFirst();
    return row?.used ?? 0;
  }

  describe('startItemAnalysis and the analysis job', () => {
    it('queues one fast analysis, runs it once, and returns it again for the same photos', async () => {
      const { itemId, hash, analysisId } = await analyzedItem();
      const queued = await getAnalysis(analysisId);
      expect(queued).toMatchObject({ itemId, photoSetHash: hash, tier: 'fast', status: 'queued' });
      expect(queued).not.toHaveProperty('result');
      expect(api.analysisJobs.jobs).toEqual([{ accountId: tenant.accountId, analysisId }]);

      expect(await api.analysisJobs.runAll()).toEqual(['succeeded']);
      const completed = await getAnalysis(analysisId);
      expect(completed).toMatchObject({ status: 'completed', tier: 'fast' });
      expect(completed.completedAt).toBeDefined();
      expect(completed.result?.details).toMatchObject({
        brand: { value: 'Patagonia', provenance: 'ocr' },
        rnNumber: { value: '12345', provenance: 'ocr' },
        upc: { value: '036000291452', provenance: 'barcode' },
        category: { value: 'clothing/outerwear/jackets', provenance: 'ai' },
        sizeLabel: { value: 'M', provenance: 'ocr' },
      });
      expect(completed.result?.variants.map((variant) => variant.marketplace)).toEqual([
        'ebay',
        'depop',
        'poshmark',
        'mercari',
      ]);
      expect(completed.result?.priceEstimate?.label).toBe(
        'AI estimate - not based on sold listings',
      );
      expect(completed.result?.needsEscalation).toBe(false);

      // Asking again for the same photo set returns the same analysis and pays nothing.
      const again = await api.call('startItemAnalysis', { token, params: { itemId } });
      expect(again.status).toBe(202);
      expect(again.body).toEqual(completed);
      expect(api.analysisJobs.jobs).toEqual([]);

      // One metered call, for the person who asked, and one AI item from the plan.
      expect(await usageEvents(itemId)).toEqual([
        {
          tier: 'standard',
          outcome: 'succeeded',
          error_code: null,
          purpose: 'item_analysis',
          user_id: tenant.userId,
          model: 'claude-haiku-5-5',
        },
      ]);
      expect(await quotaUsed('ai_items')).toBeGreaterThanOrEqual(1);
    });

    it('replays a retried request with the same Idempotency-Key', async () => {
      const itemId = await newItem();
      await addPhotos(itemId);
      const idempotencyKey = randomUUID();
      const first = await api.call('startItemAnalysis', {
        token,
        params: { itemId },
        idempotencyKey,
      });
      const retry = await api.call('startItemAnalysis', {
        token,
        params: { itemId },
        idempotencyKey,
      });
      expect(retry.status).toBe(202);
      expect(retry.body).toEqual(first.body);
      expect(api.analysisJobs.jobs).toHaveLength(1);
    });

    it('keeps the analysis when the photos are only reordered, even before its job runs', async () => {
      const { itemId, analysisId } = await analyzedItem();
      const item = await api.call('getItem', { token, params: { itemId } });
      const photoIds = item.body.photos.map((photo) => photo.id).reverse();
      const reordered = await api.call('reorderItemPhotos', {
        token,
        params: { itemId },
        body: { photoIds },
      });
      expect(reordered.status).toBe(200);

      // A new cover is the same photo set: the queued analysis runs, and nothing new is paid for.
      expect(await api.analysisJobs.runAll()).toEqual(['succeeded']);
      const again = await api.call('startItemAnalysis', { token, params: { itemId } });
      expect(again.body).toMatchObject({ id: analysisId, status: 'completed' });
      expect(api.analysisJobs.jobs).toEqual([]);
      expect(await usageEvents(itemId)).toHaveLength(1);
    });

    it('analyzes again when the photo set changes', async () => {
      const { itemId, analysisId } = await analyzedItem();
      await api.analysisJobs.runAll();
      await addPhotos(itemId);
      const next = await api.call('startItemAnalysis', { token, params: { itemId } });
      expect(next.status).toBe(202);
      expect(next.body.id).not.toBe(analysisId);
      expect(next.body.status).toBe('queued');
    });

    it('refuses an item without photos, or with photos still processing or failed', async () => {
      const empty = await newItem();
      const none = await api.call('startItemAnalysis', { token, params: { itemId: empty } });
      expect(none.status).toBe(409);
      expect(none.error).toMatchObject({ code: 'invalid_state_transition' });
      expect(none.error.message).toContain('no photos');

      const processing = await newItem();
      await addPhotos(processing, { process: false });
      const waiting = await api.call('startItemAnalysis', {
        token,
        params: { itemId: processing },
      });
      expect(waiting.status).toBe(409);
      expect(waiting.error.message).toContain('still processing');

      const broken = await newItem();
      const uploadFileId = await api.uploads.add(tenant, {
        bytes: new TextEncoder().encode('not an image'),
      });
      await api.call('addItemPhoto', {
        token,
        params: { itemId: broken },
        body: { uploadFileId, role: 'front', width: 10, height: 10 },
      });
      await api.photoJobs.runAll();
      const failed = await api.call('startItemAnalysis', { token, params: { itemId: broken } });
      expect(failed.status).toBe(409);
      expect(failed.error.message).toContain('could not be processed');
      expect(api.analysisJobs.jobs).toEqual([]);
    });

    it('rejects an answer that breaks the schema, retries once, then fails visibly and can be retried', async () => {
      const tooLong = answer({
        variants: { ...answer().variants, ebay: { title: 'x'.repeat(81), description: 'd' } },
      });
      const { itemId, hash, analysisId } = await analyzedItem(tooLong);
      expect(await api.analysisJobs.runAll()).toEqual(['failed']);
      const failed = await getAnalysis(analysisId);
      expect(failed).toMatchObject({
        status: 'failed',
        failure: {
          code: 'invalid_output',
          message: 'The AI gave an unusable answer twice in a row. Try again.',
          retryable: true,
        },
      });
      expect(failed).not.toHaveProperty('result');
      // Both calls were billed and metered.
      expect((await usageEvents(itemId)).map((event) => event.error_code)).toEqual([
        'invalid_output',
        'invalid_output',
      ]);

      // Asking again queues the same analysis again; this time the model answers well.
      api.aiControls.fixtures[hash] = {
        outputs: { [ITEM_ANALYSIS_OUTPUT_NAME]: encodeAnalysisAnswer(answer()) },
      };
      const retried = await api.call('startItemAnalysis', { token, params: { itemId } });
      expect(retried.body).toMatchObject({ id: analysisId, status: 'queued' });
      expect(retried.body).not.toHaveProperty('failure');
      expect(await api.analysisJobs.runAll()).toEqual(['succeeded']);
      expect((await getAnalysis(analysisId)).status).toBe('completed');
    });

    it('fails visibly when the photos changed before the job ran', async () => {
      const { itemId, analysisId } = await analyzedItem();
      const item = await api.call('getItem', { token, params: { itemId } });
      await api.call('deleteItemPhoto', {
        token,
        params: { itemId, photoId: item.body.photos[0]?.id ?? '' },
      });
      expect(await api.analysisJobs.runAll()).toEqual(['failed']);
      expect((await getAnalysis(analysisId)).failure).toEqual({
        code: 'photo_set_changed',
        message:
          "The item's photos changed after this analysis was requested. Analyze the item again.",
        retryable: false,
      });
      expect(await usageEvents(itemId)).toEqual([]);
    });

    it('refuses before queueing while AI is switched off or the daily budget is used up', async () => {
      const itemId = await newItem();
      await addPhotos(itemId);
      api.aiControls.killed = true;
      const off = await api.call('startItemAnalysis', { token, params: { itemId } });
      expect(off.status).toBe(503);
      expect(off.error).toMatchObject({ code: 'service_unavailable', retryable: true });
      api.aiControls.killed = false;

      const blocked = await api.signIn('analysis.blocked@example.com');
      const blockedTenant = await api.tenantOf('analysis.blocked@example.com');
      const controls = new PostgresAiControls(api.db);
      const change = { actor: 'test', reason: 'abuse review' };
      await controls.blockAccount(blockedTenant.accountId, change);
      const blockedItem = (await api.call('createItem', { token: blocked, body: {} })).body.id;
      await api.call('addItemPhoto', {
        token: blocked,
        params: { itemId: blockedItem },
        body: {
          uploadFileId: await api.uploads.add(blockedTenant, { bytes: await jpeg(998) }),
          role: 'front',
          width: 640,
          height: 480,
        },
      });
      await api.photoJobs.runAll();
      const refusedBlocked = await api.call('startItemAnalysis', {
        token: blocked,
        params: { itemId: blockedItem },
      });
      expect(refusedBlocked.status).toBe(403);
      expect(refusedBlocked.error).toMatchObject({ code: 'forbidden', retryable: false });
      await controls.unblockAccount(blockedTenant.accountId, change);

      const budget = await api.signIn('analysis.spender@example.com');
      const spender = await api.tenantOf('analysis.spender@example.com');
      await new PostgresUsageStore(api.db).record({
        accountId: spender.accountId,
        userId: null,
        itemId: null,
        purpose: 'item_analysis',
        tier: 'standard',
        provider: 'fake',
        model: 'claude-haiku-5-5',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          webSearches: 0,
        },
        images: 0,
        batch: false,
        costMicros: 1_000_000,
        priceTableVersion: '2026-10-23',
        latencyMs: 1,
        outcome: 'succeeded',
        errorCode: null,
      });
      const spenderItem = (await api.call('createItem', { token: budget, body: {} })).body.id;
      const bytes = await jpeg(999);
      const uploadFileId = await api.uploads.add(spender, { bytes });
      await api.call('addItemPhoto', {
        token: budget,
        params: { itemId: spenderItem },
        body: { uploadFileId, role: 'front', width: 640, height: 480 },
      });
      await api.photoJobs.runAll();
      const refused = await api.call('startItemAnalysis', {
        token: budget,
        params: { itemId: spenderItem },
      });
      expect(refused.status).toBe(429);
      expect(refused.error).toMatchObject({ code: 'ai_budget_exceeded', retryable: true });
      expect(refused.error.retryAfterSeconds).toBeGreaterThan(0);
      expect(refused.headers['retry-after']).toBe(String(refused.error.retryAfterSeconds));
      expect(api.analysisJobs.jobs).toEqual([]);
      const rows = await api.db
        .selectFrom('ai_analysis')
        .select('id')
        .where('item_id', 'in', [itemId, spenderItem])
        .execute();
      expect(rows).toEqual([]);
    });
  });

  describe('escalateAnalysis', () => {
    it('runs the premium identification once, on the same photos plus the first result', async () => {
      api.aiControls.autoEscalate = false;
      const { itemId, analysisId } = await analyzedItem();
      const early = await api.call('escalateAnalysis', { token, params: { analysisId } });
      expect(early.status).toBe(409);
      expect(early.error.message).toContain('not completed');
      await api.analysisJobs.runAll();

      const before = await quotaUsed('premium_identifications');
      const escalated = await api.call('escalateAnalysis', { token, params: { analysisId } });
      expect(escalated.status).toBe(202);
      expect(escalated.body).toMatchObject({
        tier: 'premium',
        status: 'queued',
        escalatedFromAnalysisId: analysisId,
      });
      const premiumId = escalated.body.id;
      expect((await getAnalysis(analysisId)).escalationAnalysisId).toBe(premiumId);

      expect(await api.analysisJobs.runAll()).toEqual(['succeeded']);
      const premium = await getAnalysis(premiumId);
      expect(premium).toMatchObject({ status: 'completed', tier: 'premium' });
      expect(premium.result?.needsEscalation).toBe(false);
      expect((await usageEvents(itemId)).map((event) => [event.tier, event.model])).toEqual([
        ['standard', 'claude-haiku-5-5'],
        ['premium', 'claude-sonnet-5-5'],
      ]);
      expect(await quotaUsed('premium_identifications')).toBe(before + 1);

      // Repeating returns the same premium analysis; a premium one cannot be escalated.
      const again = await api.call('escalateAnalysis', { token, params: { analysisId } });
      expect(again.body.id).toBe(premiumId);
      expect(api.analysisJobs.jobs).toEqual([]);
      const twice = await api.call('escalateAnalysis', {
        token,
        params: { analysisId: premiumId },
      });
      expect(twice.status).toBe(409);
    });

    it("refuses when the plan's premium quota is used up", async () => {
      api.aiControls.autoEscalate = false;
      const { analysisId } = await analyzedItem();
      await api.analysisJobs.runAll();
      const now = new Date();
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const day = (date: Date) => date.toISOString().slice(0, 10);
      await api.db
        .insertInto('usage_counter')
        .values({
          account_id: tenant.accountId,
          metric: 'premium_identifications',
          period_start: day(periodStart),
          period_end: day(periodEnd),
          used: 15,
          quota: 15,
        })
        .onConflict((conflict) =>
          conflict
            .columns(['account_id', 'metric', 'period_start'])
            .doUpdateSet((eb) => ({ quota: eb.ref('usage_counter.used') })),
        )
        .execute();
      try {
        const refused = await api.call('escalateAnalysis', { token, params: { analysisId } });
        expect(refused.status).toBe(402);
        expect(refused.error).toMatchObject({
          code: 'quota_exceeded',
          message: "This month's premium identifications in your plan are used up.",
        });
        expect(api.analysisJobs.jobs).toEqual([]);
      } finally {
        await api.db
          .updateTable('usage_counter')
          .set({ quota: null })
          .where('account_id', '=', tenant.accountId)
          .execute();
      }
    });

    it('escalates on its own when the fast analysis asks for it and the quota allows', async () => {
      const designer = answer({
        looksDesigner: true,
        attributes: {
          ...answer().attributes,
          brand: { value: 'Gucci', confidence: 0.5, source: 'photo' },
        },
      });
      const { itemId, analysisId } = await analyzedItem(designer);
      expect(await api.analysisJobs.runAll()).toEqual(['succeeded', 'succeeded']);
      const fast = await getAnalysis(analysisId);
      expect(fast.result).toMatchObject({
        needsEscalation: true,
        escalationReason: 'The brand is uncertain. It looks like a designer item.',
      });
      expect(fast.escalationAnalysisId).toBeDefined();
      const premium = await getAnalysis(fast.escalationAnalysisId ?? '');
      expect(premium).toMatchObject({
        tier: 'premium',
        status: 'completed',
        escalatedFromAnalysisId: analysisId,
      });
      expect((await usageEvents(itemId)).map((event) => event.tier)).toEqual([
        'standard',
        'premium',
      ]);
    });

    it('leaves escalation to the user when automatic escalation is off', async () => {
      api.aiControls.autoEscalate = false;
      const { analysisId } = await analyzedItem(answer({ looksVintage: true }));
      expect(await api.analysisJobs.runAll()).toEqual(['succeeded']);
      const fast = await getAnalysis(analysisId);
      expect(fast.result?.needsEscalation).toBe(true);
      expect(fast).not.toHaveProperty('escalationAnalysisId');
    });
  });

  describe('applyAnalysis', () => {
    async function completedItem() {
      api.aiControls.autoEscalate = false;
      const analyzed = await analyzedItem();
      await api.analysisJobs.runAll();
      return analyzed;
    }

    async function item(itemId: string) {
      return (await api.call('getItem', { token, params: { itemId } })).body;
    }

    it('fills the item with provenance, never overwriting what the user entered', async () => {
      const { itemId, analysisId } = await completedItem();
      const draft = await item(itemId);
      const edited = await api.call('replaceItem', {
        token,
        params: { itemId },
        body: { expectedVersion: draft.version, details: { brand: 'My own brand note' } },
      });
      expect(edited.body.fieldProvenance).toEqual({ brand: 'user' });

      const applied = await api.call('applyAnalysis', {
        token,
        params: { analysisId },
        body: { expectedVersion: edited.body.version },
      });
      expect(applied.status).toBe(200);
      expect(applied.body.details).toMatchObject({
        brand: 'My own brand note',
        title: "Patagonia Better Sweater Fleece Jacket, Women's M",
        rnNumber: '12345',
        upc: '036000291452',
        category: 'clothing/outerwear/jackets',
        sizeLabel: 'M',
        sizeSystem: 'letter',
        colors: ['gray'],
        materials: ['polyester'],
        condition: 'pre_owned_excellent',
        acceptedAnalysisId: analysisId,
      });
      expect(applied.body.fieldProvenance).toMatchObject({
        brand: 'user',
        title: 'ai',
        rnNumber: 'ocr',
        upc: 'barcode',
        category: 'ai',
        sizeLabel: 'ocr',
      });
      expect(applied.body.fieldProvenance).not.toHaveProperty('acceptedAnalysisId');
      expect(applied.body.version).toBe(edited.body.version + 1);

      const history = await api.db
        .selectFrom('audit_log')
        .select(['action', 'changes'])
        .where('item_id', '=', itemId)
        .where('action', '=', 'item.analysis_applied')
        .execute();
      expect(history).toHaveLength(1);
      expect(history[0]?.changes).toMatchObject({ analysisId, rnNumber: { to: '12345' } });

      // A later replace that keeps the values keeps their sources; an edit becomes `user`.
      const kept = await api.call('replaceItem', {
        token,
        params: { itemId },
        body: {
          expectedVersion: applied.body.version,
          details: { ...applied.body.details, title: 'Fleece jacket' },
        },
      });
      expect(kept.body.fieldProvenance).toMatchObject({
        rnNumber: 'ocr',
        upc: 'barcode',
        title: 'user',
      });
    });

    it("gives a value typed to match the accepted analysis that analysis's source", async () => {
      const { itemId, analysisId } = await completedItem();
      const draft = await item(itemId);
      const typed = await api.call('replaceItem', {
        token,
        params: { itemId },
        body: {
          expectedVersion: draft.version,
          details: { rnNumber: '12345', brand: 'Patagonia ', acceptedAnalysisId: analysisId },
        },
      });
      expect(typed.status).toBe(200);
      // `Patagonia ` differs from the proposal, so it is the user's own value.
      expect(typed.body.fieldProvenance).toMatchObject({ rnNumber: 'ocr', brand: 'user' });
    });

    it('refuses a stale version, an analysis that has not completed, and other accounts', async () => {
      const { itemId, analysisId } = await completedItem();
      const draft = await item(itemId);
      const stale = await api.call('applyAnalysis', {
        token,
        params: { analysisId },
        body: { expectedVersion: draft.version + 5 },
      });
      expect(stale.status).toBe(409);
      expect(stale.error.code).toBe('version_conflict');

      const pending = await analyzedItem();
      const pendingItem = await item(pending.itemId);
      const early = await api.call('applyAnalysis', {
        token,
        params: { analysisId: pending.analysisId },
        body: { expectedVersion: pendingItem.version },
      });
      expect(early.status).toBe(409);
      expect(early.error.code).toBe('invalid_state_transition');

      for (const operation of ['getAnalysis', 'escalateAnalysis'] as const) {
        const hidden = await api.call(operation, { token: strangerToken, params: { analysisId } });
        expect(hidden.status).toBe(404);
      }
      const foreign = await api.call('applyAnalysis', {
        token: strangerToken,
        params: { analysisId },
        body: { expectedVersion: draft.version },
      });
      expect(foreign.status).toBe(404);
      const foreignStart = await api.call('startItemAnalysis', {
        token: strangerToken,
        params: { itemId },
      });
      expect(foreignStart.status).toBe(404);
    });
  });
});
