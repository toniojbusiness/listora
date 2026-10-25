import { randomUUID } from 'node:crypto';

import {
  encodeAnalysisAnswer,
  ITEM_ANALYSIS_OUTPUT_NAME,
  type ItemAnalysisOutput,
} from '@listora/analysis';
import { DEFAULT_BATCH_JOB_TIMING } from '@listora/batches';
import { photoSetHash, sha256Hex } from '@listora/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Tenant } from '../tenancy.ts';
import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';

const OWNER = 'batch.owner@example.com';
const STRANGER = 'batch.stranger@example.com';

/** A small JPEG; `seed` makes each one a different file. */
async function jpeg(seed: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: seed % 256, g: 60, b: 90 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer(),
  );
}

const ANSWER: ItemAnalysisOutput = {
  attributes: {
    brand: { value: 'Levi Strauss', confidence: 0.92, source: 'tag_text' },
    productName: null,
    styleNumber: null,
    rnNumber: null,
    upc: null,
    department: { value: 'men', confidence: 0.9, source: 'photo' },
    category: { value: 'clothing/bottoms', confidence: 0.9, source: 'photo' },
    subcategory: { value: 'jeans', confidence: 0.9, source: 'photo' },
    sizeLabel: { value: '32x30', confidence: 0.9, source: 'tag_text' },
    sizeSystem: { value: 'waist_inseam', confidence: 0.9, source: 'tag_text' },
    colors: { values: ['blue'], confidence: 0.9, source: 'photo' },
    pattern: { value: 'solid', confidence: 0.9, source: 'photo' },
    materials: { values: ['cotton'], confidence: 0.8, source: 'tag_text' },
    condition: { value: 'pre_owned_good', confidence: 0.8, source: 'photo' },
    conditionNotes: null,
    flaws: null,
    keywords: { values: ['denim'], confidence: 0.7, source: 'photo' },
  },
  title: { value: "Levi's 501 Jeans 32x30", confidence: 0.85 },
  description: { value: 'Classic blue jeans.', confidence: 0.8 },
  variants: {
    ebay: { title: "Levi's 501 Jeans Mens 32x30 Blue", description: 'Blue jeans.' },
    depop: { title: "Levi's 501", description: 'Classic denim.', hashtags: ['denim'] },
    poshmark: { title: "Levi's 501 Jeans", description: 'Classic fit.' },
    mercari: { title: "Levi's 501 Jeans 32x30", description: 'Blue jeans.' },
  },
  priceEstimate: { lowCents: 2_000, midCents: 3_000, highCents: 4_000, confidence: 0.6 },
  looksVintage: false,
  looksDesigner: false,
  needsEscalation: false,
  escalationReason: null,
};

describe('item batches (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;
  let strangerToken: string;
  let seed = 0;

  beforeAll(async () => {
    api = await createTestApi('batches');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
    strangerToken = await api.signIn(STRANGER);
  });

  afterAll(async () => {
    await api.close();
  });

  beforeEach(() => {
    api.aiControls.killed = false;
    api.aiControls.autoEscalate = false;
    api.analysisJobs.jobs.length = 0;
    api.batchJobs.jobs.length = 0;
    api.photoJobs.jobs.length = 0;
  });

  async function newBatch(): Promise<string> {
    const created = await api.call('createItemBatch', { token });
    expect(created.status).toBe(201);
    return created.body.id;
  }

  async function addItem(batchId: string, position: number, idempotencyKey?: string) {
    return api.call('addItemBatchItem', {
      token,
      params: { batchId },
      body: { position },
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
  }

  /** Attaches `count` photos (the second a tag) without processing them; returns the set's hash. */
  async function attachPhotos(itemId: string, count = 2, bytes?: Uint8Array): Promise<string> {
    const hashes: string[] = [];
    for (let index = 0; index < count; index += 1) {
      seed += 1;
      const file = bytes ?? (await jpeg(seed));
      hashes.push(sha256Hex(file));
      const added = await api.call('addItemPhoto', {
        token,
        params: { itemId },
        body: {
          uploadFileId: await api.uploads.add(tenant, { bytes: file }),
          role: index === 1 ? 'tag' : 'front',
          width: 640,
          height: 480,
        },
      });
      expect(added.status).toBe(201);
    }
    const hash = photoSetHash(hashes);
    api.aiControls.fixtures[hash] = {
      outputs: { [ITEM_ANALYSIS_OUTPUT_NAME]: encodeAnalysisAnswer(ANSWER) },
    };
    return hash;
  }

  async function submit(batchId: string, itemId: string, photoCount = 2) {
    return api.call('submitItemBatchItem', {
      token,
      params: { batchId, itemId },
      body: { photoCount },
    });
  }

  async function getBatch(batchId: string) {
    const batch = await api.call('getItemBatch', { token, params: { batchId } });
    expect(batch.status).toBe(200);
    return batch.body;
  }

  async function stateOf(batchId: string, itemId: string) {
    const item = (await getBatch(batchId)).items.find((entry) => entry.item.id === itemId);
    if (item === undefined) throw new Error(`item ${itemId} is not in the batch`);
    return item;
  }

  it('creates one draft item with a SKU per position, in haul order', async () => {
    const batchId = await newBatch();
    const added = [];
    for (const position of [0, 1, 2]) {
      const response = await addItem(batchId, position);
      expect(response.status).toBe(201);
      added.push(response.body);
    }
    for (const entry of added) {
      expect(entry.item.status).toBe('draft');
      expect(entry.item.sku).toMatch(/^[A-Z0-9]+-\d{6}$/);
      expect(entry).toMatchObject({
        state: 'uploading',
        statusDisplay: { tone: 'in_progress', label: 'Uploading photos...' },
        photos: { total: 0, ready: 0 },
      });
    }
    expect(new Set(added.map((entry) => entry.item.sku)).size).toBe(3);

    const batch = await getBatch(batchId);
    expect(batch.items.map((entry) => entry.position)).toEqual([0, 1, 2]);
    expect(batch.items.map((entry) => entry.item.id)).toEqual(added.map((entry) => entry.item.id));
    expect(batch.progress).toEqual({
      total: 3,
      uploading: 3,
      preparingPhotos: 0,
      analyzing: 0,
      readyForReview: 0,
      saved: 0,
      failed: 0,
    });
    expect(batch.interaction).toBeUndefined();
  });

  it('answers a resubmitted position with the item already there, never a second item', async () => {
    const batchId = await newBatch();
    const key = randomUUID();
    const first = await addItem(batchId, 0, key);
    expect(first.status).toBe(201);

    // The same request replays; a new key (the old one expired, or the app lost it) finds the item.
    const replayed = await addItem(batchId, 0, key);
    expect(replayed.status).toBe(201);
    expect(replayed.body.item.id).toBe(first.body.item.id);
    const again = await addItem(batchId, 0);
    expect(again.status).toBe(200);
    expect(again.body.item.id).toBe(first.body.item.id);
    expect(again.body.item.sku).toBe(first.body.item.sku);

    expect((await getBatch(batchId)).items).toHaveLength(1);
    const items = await api.db
      .selectFrom('item_batch_item')
      .select('item_id')
      .where('batch_id', '=', batchId)
      .execute();
    expect(items).toHaveLength(1);
  });

  it('starts the analysis once every photo is attached and processed, then shows it ready', async () => {
    const batchId = await newBatch();
    const itemId = (await addItem(batchId, 0)).body.item.id;
    await attachPhotos(itemId);
    expect((await stateOf(batchId, itemId)).state).toBe('uploading');

    const early = await submit(batchId, itemId, 3);
    expect(early.status).toBe(409);
    expect(early.error.code).toBe('invalid_state_transition');
    expect(early.error.message).toBe(
      'This item has 2 of its 3 photos. Attach the rest, then submit it again.',
    );
    expect(api.batchJobs.jobs).toHaveLength(0);

    const submitted = await submit(batchId, itemId);
    expect(submitted.status).toBe(202);
    expect(submitted.body).toMatchObject({
      state: 'preparing_photos',
      statusDisplay: { tone: 'in_progress', label: 'Preparing photos (0 of 2)...' },
      photos: { total: 2, ready: 0 },
    });

    // Photos still processing: the job checks again shortly instead of starting anything.
    expect(await api.batchJobs.runAll()).toEqual(['waiting_for_photos']);
    expect(api.analysisJobs.jobs).toHaveLength(0);
    const retry = api.batchJobs.jobs[0];
    expect(retry?.itemId).toBe(itemId);
    expect(retry?.runAt?.getTime()).toBe(api.clock.now + DEFAULT_BATCH_JOB_TIMING.pollDelayMs);

    await api.photoJobs.runAll();
    expect(await api.batchJobs.runAll()).toEqual(['started']);
    expect(api.analysisJobs.jobs).toHaveLength(1);
    expect(await stateOf(batchId, itemId)).toMatchObject({
      state: 'analyzing',
      statusDisplay: { tone: 'in_progress', label: 'Analyzing...' },
      photos: { total: 2, ready: 2 },
    });

    expect(await api.analysisJobs.runAll()).toEqual(['succeeded']);
    const ready = await stateOf(batchId, itemId);
    expect(ready).toMatchObject({
      state: 'ready_for_review',
      statusDisplay: { tone: 'action_needed', label: 'Ready to review' },
    });
    expect(ready.problem).toBeUndefined();

    // The analysis is the item's own: the review applies and saves it as for any item.
    const analyses = await api.db
      .selectFrom('ai_analysis')
      .select(['tier', 'requested_by_user_id'])
      .where('item_id', '=', itemId)
      .execute();
    expect(analyses).toEqual([{ tier: 'standard', requested_by_user_id: tenant.userId }]);
    const item = (await api.call('getItem', { token, params: { itemId } })).body;
    const saved = await api.call('replaceItem', {
      token,
      params: { itemId },
      body: { expectedVersion: item.version, status: 'ready', details: { title: 'Jeans' } },
    });
    expect(saved.status).toBe(200);
    const batch = await getBatch(batchId);
    expect(batch.items[0]).toMatchObject({
      state: 'saved',
      statusDisplay: { tone: 'success', label: 'Saved' },
    });
    expect(batch.progress).toMatchObject({ total: 1, saved: 1, readyForReview: 0 });

    // Submitting a saved item again does nothing.
    expect((await submit(batchId, itemId)).status).toBe(202);
    expect(await api.batchJobs.runAll()).toEqual(['skipped']);
    expect(api.analysisJobs.jobs).toHaveLength(0);
  });

  it('keeps the analysis the photo set already has instead of paying for another', async () => {
    const batchId = await newBatch();
    const itemId = (await addItem(batchId, 0)).body.item.id;
    await attachPhotos(itemId);
    await api.photoJobs.runAll();
    const started = await api.call('startItemAnalysis', { token, params: { itemId } });
    expect(started.status).toBe(202);
    api.analysisJobs.jobs.length = 0;

    expect((await submit(batchId, itemId)).status).toBe(202);
    expect(await api.batchJobs.runAll()).toEqual(['already_analyzed']);
    expect(api.analysisJobs.jobs).toHaveLength(0);
  });

  it('records a guard refusal on the item, and a resubmit retries it', async () => {
    const batchId = await newBatch();
    const itemId = (await addItem(batchId, 0)).body.item.id;
    await attachPhotos(itemId);
    await api.photoJobs.runAll();
    api.aiControls.killed = true;
    await submit(batchId, itemId);
    expect(await api.batchJobs.runAll()).toEqual(['blocked']);
    expect(api.analysisJobs.jobs).toHaveLength(0);
    expect(await stateOf(batchId, itemId)).toMatchObject({
      state: 'failed',
      statusDisplay: {
        tone: 'failed',
        label: "Couldn't start the analysis - Retry",
        detail: 'AI analysis is paused right now. Try again later.',
      },
      problem: {
        code: 'ai_unavailable',
        message: 'AI analysis is paused right now. Try again later.',
        retryable: true,
      },
    });
    expect((await getBatch(batchId)).progress).toMatchObject({ failed: 1 });

    api.aiControls.killed = false;
    const resubmitted = await submit(batchId, itemId);
    expect(resubmitted.body.state).toBe('analyzing');
    expect(resubmitted.body.problem).toBeUndefined();
    expect(await api.batchJobs.runAll()).toEqual(['started']);
    expect(api.analysisJobs.jobs).toHaveLength(1);
  });

  it('pauses on a used-up plan quota without calling it a failure of the item', async () => {
    const batchId = await newBatch();
    const itemId = (await addItem(batchId, 0)).body.item.id;
    await attachPhotos(itemId);
    await api.photoJobs.runAll();
    const now = new Date();
    const day = (date: Date) => date.toISOString().slice(0, 10);
    await api.db
      .insertInto('usage_counter')
      .values({
        account_id: tenant.accountId,
        metric: 'ai_items',
        period_start: day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
        period_end: day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))),
        used: 5,
        quota: 5,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['account_id', 'metric', 'period_start'])
          .doUpdateSet((eb) => ({ quota: eb.ref('usage_counter.used') })),
      )
      .execute();
    try {
      await submit(batchId, itemId);
      expect(await api.batchJobs.runAll()).toEqual(['blocked']);
      expect(await stateOf(batchId, itemId)).toMatchObject({
        state: 'failed',
        statusDisplay: { tone: 'action_needed', label: "Paused - your plan's limit is reached" },
        problem: { code: 'quota_exceeded', retryable: false },
      });
    } finally {
      await api.db
        .updateTable('usage_counter')
        .set({ quota: null })
        .where('account_id', '=', tenant.accountId)
        .execute();
    }
  });

  it('shows a photo the server could not process, with its reason', async () => {
    const batchId = await newBatch();
    const itemId = (await addItem(batchId, 0)).body.item.id;
    await attachPhotos(itemId, 1, new TextEncoder().encode(`not a jpeg ${randomUUID()}`));
    await submit(batchId, itemId, 1);
    await api.photoJobs.runAll();
    expect(await api.batchJobs.runAll()).toEqual(['photo_failed']);
    const failed = await stateOf(batchId, itemId);
    expect(failed).toMatchObject({
      state: 'failed',
      statusDisplay: { tone: 'failed', label: 'Photo failed - replace it' },
      problem: { code: 'photo_failed', retryable: false },
    });
    expect(failed.problem?.message).toBeTruthy();
  });

  it('stops waiting for photos after the deadline, with a reason that says to try again', async () => {
    const batchId = await newBatch();
    const itemId = (await addItem(batchId, 0)).body.item.id;
    await attachPhotos(itemId);
    await submit(batchId, itemId);
    const start = api.clock.now;
    try {
      api.clock.now = start + DEFAULT_BATCH_JOB_TIMING.photoDeadlineMs;
      expect(await api.batchJobs.runAll()).toEqual(['photos_timed_out']);
      expect(api.batchJobs.jobs).toHaveLength(0);
      expect(await stateOf(batchId, itemId)).toMatchObject({
        state: 'failed',
        problem: { code: 'photos_not_ready', retryable: true },
      });
    } finally {
      api.clock.now = start;
    }
  });

  it("records the batch's interaction and each item's share", async () => {
    const batchId = await newBatch();
    const first = (await addItem(batchId, 0)).body.item.id;
    const second = (await addItem(batchId, 1)).body.item.id;
    const recorded = await api.call('replaceItemBatchInteraction', {
      token,
      params: { batchId },
      body: {
        batch: { activeMs: 41_000, waitingMs: 9_000, taps: 23 },
        items: [{ itemId: first, interaction: { activeMs: 19_000, waitingMs: 4_000, taps: 11 } }],
      },
    });
    expect(recorded.status).toBe(200);
    expect(recorded.body.interaction).toEqual({ activeMs: 41_000, waitingMs: 9_000, taps: 23 });
    expect(recorded.body.items[0]?.interaction).toEqual({
      activeMs: 19_000,
      waitingMs: 4_000,
      taps: 11,
    });
    expect(recorded.body.items[1]?.interaction).toBeUndefined();

    // A full replacement: the first item's share goes when it is left out.
    const replaced = await api.call('replaceItemBatchInteraction', {
      token,
      params: { batchId },
      body: {
        batch: { activeMs: 50_000, waitingMs: 9_000, taps: 30 },
        items: [{ itemId: second, interaction: { activeMs: 9_000, waitingMs: 0, taps: 7 } }],
      },
    });
    expect(replaced.body.items.map((entry) => entry.interaction?.taps)).toEqual([undefined, 7]);

    const stray = (await api.call('createItem', { token, body: {} })).body.id;
    const unknown = await api.call('replaceItemBatchInteraction', {
      token,
      params: { batchId },
      body: {
        batch: { activeMs: 1, waitingMs: 0, taps: 1 },
        items: [
          { itemId: first, interaction: { activeMs: 1, waitingMs: 0, taps: 1 } },
          { itemId: stray, interaction: { activeMs: 1, waitingMs: 0, taps: 1 } },
        ],
      },
    });
    expect(unknown.status).toBe(422);
    expect(fieldsOf(unknown)).toEqual(['items[1].itemId']);
    const twice = await api.call('replaceItemBatchInteraction', {
      token,
      params: { batchId },
      body: {
        batch: { activeMs: 1, waitingMs: 0, taps: 1 },
        items: [
          { itemId: first, interaction: { activeMs: 1, waitingMs: 0, taps: 1 } },
          { itemId: first, interaction: { activeMs: 2, waitingMs: 0, taps: 2 } },
        ],
      },
    });
    expect(twice.status).toBe(422);
    expect(fieldsOf(twice)).toEqual(['items[1].itemId']);
    // Neither refusal changed what was recorded.
    expect((await getBatch(batchId)).interaction).toEqual({
      activeMs: 50_000,
      waitingMs: 9_000,
      taps: 30,
    });
  });

  it('drops an item from its batch when the item is deleted', async () => {
    const batchId = await newBatch();
    const kept = (await addItem(batchId, 0)).body.item.id;
    const deleted = (await addItem(batchId, 1)).body.item.id;
    expect((await api.call('deleteItem', { token, params: { itemId: deleted } })).status).toBe(204);
    const batch = await getBatch(batchId);
    expect(batch.items.map((entry) => entry.item.id)).toEqual([kept]);
    expect(batch.progress.total).toBe(1);
  });

  it("never shows or changes another account's batch", async () => {
    const batchId = await newBatch();
    const itemId = (await addItem(batchId, 0)).body.item.id;
    const get = await api.call('getItemBatch', { token: strangerToken, params: { batchId } });
    expect(get.status).toBe(404);
    const add = await api.call('addItemBatchItem', {
      token: strangerToken,
      params: { batchId },
      body: { position: 1 },
    });
    expect(add.status).toBe(404);
    const submitted = await api.call('submitItemBatchItem', {
      token: strangerToken,
      params: { batchId, itemId },
      body: { photoCount: 1 },
    });
    expect(submitted.status).toBe(404);
    const interaction = await api.call('replaceItemBatchInteraction', {
      token: strangerToken,
      params: { batchId },
      body: { batch: { activeMs: 1, waitingMs: 0, taps: 1 }, items: [] },
    });
    expect(interaction.status).toBe(404);
    expect((await getBatch(batchId)).items).toHaveLength(1);
  });

  it('refuses positions and photo counts outside the contract', async () => {
    const batchId = await newBatch();
    const tooFar = await addItem(batchId, 1000);
    expect(tooFar.status).toBe(422);
    expect(fieldsOf(tooFar)).toEqual(['position']);
    const itemId = (await addItem(batchId, 0)).body.item.id;
    const none = await submit(batchId, itemId, 0);
    expect(none.status).toBe(422);
    expect(fieldsOf(none)).toEqual(['photoCount']);
  });
});
