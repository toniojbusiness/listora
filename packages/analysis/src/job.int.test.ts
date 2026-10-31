import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AiClient,
  createModelRegistry,
  CURRENT_PRICE_TABLE,
  FakeAiProvider,
  inMemoryFixtures,
  PostgresQuotaPolicy,
  PostgresUsageStore,
  staticKillSwitch,
  type AiProvider,
  type FakeFixture,
  type ProviderRequest,
} from '@listora/ai';
import {
  createDatabase,
  createInventoryItem,
  jsonb,
  SchemaMigrator,
  type Db,
  type JsonObject,
} from '@listora/db';
import { parsePhotoDerivatives, processPhoto, storageKeys } from '@listora/photos';
import { createLogger, photoSetHash, sha256Hex } from '@listora/shared';
import { LocalDiskStorage } from '@listora/storage';
import { createScratchDatabase, type ScratchDatabase } from '@listora/testing';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadDescriptionStyle, saveDescriptionStyle } from './description-style.ts';
import { runItemAnalysis, type AnalysisJobDependencies } from './job.ts';
import { ITEM_ANALYSIS_SYSTEM } from './prompt.ts';
import type { AnalysisJobPayload } from './queue.ts';
import { requestAnalysis } from './repository.ts';
import { analysisFixture, answer } from './test-support.ts';

const logger = createLogger({ service: 'analysis-test', level: 'silent' });

async function jpeg(width: number, height: number, seed: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r: seed, g: 9, b: 99 } } })
      .jpeg()
      .toBuffer(),
  );
}

/** Records the requests it is sent, answering from fixtures like the fake provider. */
class RecordingProvider implements AiProvider {
  readonly id = 'fake';
  readonly requests: ProviderRequest<unknown>[] = [];
  readonly #fake: FakeAiProvider;

  constructor(fixtures: Record<string, FakeFixture>) {
    this.#fake = new FakeAiProvider({ fixtures: inMemoryFixtures(fixtures) });
  }

  generate<T>(request: ProviderRequest<T>) {
    this.requests.push(request);
    return this.#fake.generate(request);
  }
}

describe('runItemAnalysis (real Postgres and local storage)', () => {
  let scratch: ScratchDatabase;
  let db: Db;
  let rootDir: string;
  let storage: LocalDiskStorage;
  let accountId: string;
  let fixtures: Record<string, FakeFixture>;
  let provider: RecordingProvider;
  let ai: AiClient;
  const queued: AnalysisJobPayload[] = [];

  beforeAll(async () => {
    scratch = await createScratchDatabase('analysis_job');
    db = createDatabase({ connectionString: scratch.url, max: 5 });
    await new SchemaMigrator(db).migrateToLatest();
    ({ id: accountId } = await db
      .insertInto('account')
      .values({ name: 'Analysis', sku_prefix: 'AN' })
      .returning('id')
      .executeTakeFirstOrThrow());
  });

  afterAll(async () => {
    await db.destroy();
    await scratch.drop();
    await rm(rootDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
    rootDir = await mkdtemp(join(tmpdir(), 'listora-analysis-'));
    storage = new LocalDiskStorage({
      rootDir,
      baseUrl: 'http://127.0.0.1:3000',
      signingSecret: 'analysis-test-secret-0123456789abcdefgh',
    });
    fixtures = {};
    provider = new RecordingProvider(fixtures);
    ai = new AiClient({
      provider,
      registry: createModelRegistry({}, CURRENT_PRICE_TABLE),
      usageStore: new PostgresUsageStore(db),
      killSwitch: staticKillSwitch(false),
      dailyBudgetMicros: 10_000_000,
      quota: new PostgresQuotaPolicy(db),
    });
    queued.length = 0;
  });

  function deps(overrides: Partial<AnalysisJobDependencies> = {}): AnalysisJobDependencies {
    return {
      db,
      storage,
      ai,
      jobs: { enqueue: (_executor, job) => Promise.resolve(void queued.push(job)) },
      logger,
      autoEscalate: true,
      ...overrides,
    };
  }

  /** An item with processed photos (a large tag photo among them) and its queued analysis. */
  async function queuedAnalysis(roles: readonly ('front' | 'tag')[] = ['front', 'tag']) {
    const item = await createInventoryItem(db, accountId);
    const hashes: string[] = [];
    for (const [position, role] of roles.entries()) {
      const bytes = await jpeg(2048, 1536, position + 1);
      hashes.push(sha256Hex(bytes));
      const storageKey = storageKeys.upload(accountId, crypto.randomUUID());
      await storage.put(storageKey, bytes, { contentType: 'image/jpeg' });
      const photo = await db
        .insertInto('photo')
        .values({
          account_id: accountId,
          item_id: item.id,
          position,
          role,
          storage_key: storageKey,
          width: 2048,
          height: 1536,
          sha256: sha256Hex(bytes),
          ocr_lines: jsonb(role === 'tag' ? [{ text: 'RN 12345', confidence: 0.9 }] : []),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await processPhoto({ db, storage, logger }, { accountId, photoId: photo.id });
    }
    const hash = photoSetHash(hashes);
    fixtures[hash] = analysisFixture(answer());
    const { row } = await requestAnalysis(db, deps().jobs, {
      accountId,
      itemId: item.id,
      photoSetHash: hash,
      tier: 'standard',
      model: 'claude-haiku-5-5',
      requestedByUserId: null,
    });
    queued.length = 0;
    return { itemId: item.id, hash, analysisId: row.id };
  }

  async function analysisRow(analysisId: string) {
    return db
      .selectFrom('ai_analysis')
      .selectAll()
      .where('id', '=', analysisId)
      .executeTakeFirstOrThrow();
  }

  it('sends the ai images and a sharper crop of the tag photo, then stores the result', async () => {
    const { analysisId, hash } = await queuedAnalysis();
    expect(await runItemAnalysis(deps(), { accountId, analysisId })).toBe('succeeded');

    const request = provider.requests[0];
    expect(request?.photoSetHash).toBe(hash);
    expect(request?.images.map((image) => [image.width, image.height])).toEqual([
      [1024, 768],
      [1024, 768],
      [784, 784],
    ]);
    const row = await analysisRow(analysisId);
    expect(row).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      model: 'claude-haiku-5-5',
      error_code: null,
    });
    expect(row.completed_at).toBeInstanceOf(Date);
    expect(row.output).toMatchObject({
      details: { rnNumber: { value: '12345', provenance: 'ocr' } },
      needsEscalation: false,
    });
    // Running the job again (a duplicate delivery) does nothing and pays nothing.
    expect(await runItemAnalysis(deps(), { accountId, analysisId })).toBe('skipped');
    expect(provider.requests).toHaveLength(1);
  });

  it("sends the seller's own Depop style with the item, and none once they go back to the default", async () => {
    const depop = 'Short and plain: one sentence, the size, then the flaws.';
    expect(await saveDescriptionStyle(db, accountId, { depop })).toEqual({ depop });
    expect(await loadDescriptionStyle(db, accountId)).toEqual({ depop });
    const styled = await queuedAnalysis(['front']);
    expect(await runItemAnalysis(deps(), { accountId, analysisId: styled.analysisId })).toBe(
      'succeeded',
    );
    const sent = JSON.parse(provider.requests[0]?.prompt ?? '{}') as Record<string, unknown>;
    expect(sent['depopStyle']).toBe(depop);
    expect(provider.requests[0]?.system).toBe(ITEM_ANALYSIS_SYSTEM);

    expect(await saveDescriptionStyle(db, accountId, { depop: null })).toEqual({ depop: null });
    expect(await loadDescriptionStyle(db, accountId)).toEqual({ depop: null });
    const plain = await queuedAnalysis(['tag']);
    expect(await runItemAnalysis(deps(), { accountId, analysisId: plain.analysisId })).toBe(
      'succeeded',
    );
    const unstyled = JSON.parse(provider.requests[1]?.prompt ?? '{}') as Record<string, unknown>;
    expect(unstyled).not.toHaveProperty('depopStyle');
  });

  /** A sourcing run and a scan of it, kept as `itemId` when given. */
  async function scanOf(account: string, itemId: string | null, read: JsonObject) {
    const run = await db
      .insertInto('sourcing_run')
      .values({ account_id: account })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('item_scan')
      .values({
        account_id: account,
        run_id: run.id,
        image_sha256: sha256Hex(crypto.randomUUID()),
        image_count: 1,
        read: jsonb(read),
        call: 'your_call',
        confidence: 'low',
        basis: 'ai_estimate',
        call_detail: jsonb({}),
        decision: itemId === null ? 'undecided' : 'kept',
        item_id: itemId,
        model: 'claude-haiku-5-5',
        ai_attempts: 1,
        cost_micros: 400,
        read_ms: 1500,
      })
      .execute();
  }

  it('sends the read of the thrift scan the item was kept from as a hint, and none otherwise', async () => {
    const kept = await queuedAnalysis(['front']);
    await scanOf(accountId, kept.itemId, {
      brand: 'Patagonia',
      item: 'green fleece pullover',
      sizeLabel: 'M',
      identityConfidence: 0.7,
      aiEstimate: { lowCents: 2000, midCents: 3000, highCents: 4000 },
      flags: { visibleDamage: false, lotOrBundle: false, counterfeitProne: false },
    });
    // A scan never kept, of the same account, gives no item a hint.
    await scanOf(accountId, null, { brand: 'Levi', item: 'jeans' });
    expect(await runItemAnalysis(deps(), { accountId, analysisId: kept.analysisId })).toBe(
      'succeeded',
    );
    const sent = JSON.parse(provider.requests[0]?.prompt ?? '{}') as Record<string, unknown>;
    expect(sent['scanRead']).toMatchObject({
      brand: 'Patagonia',
      item: 'green fleece pullover',
      sizeLabel: 'M',
      identityConfidence: 0.7,
      visibleDamage: false,
    });
    expect(JSON.stringify(sent['scanRead'])).not.toContain('Cents');

    const plain = await queuedAnalysis(['front']);
    expect(await runItemAnalysis(deps(), { accountId, analysisId: plain.analysisId })).toBe(
      'succeeded',
    );
    const unhinted = JSON.parse(provider.requests[1]?.prompt ?? '{}') as Record<string, unknown>;
    expect(unhinted).not.toHaveProperty('scanRead');
  });

  it('takes over an analysis left running by a crashed run', async () => {
    const { analysisId } = await queuedAnalysis(['front']);
    await db
      .updateTable('ai_analysis')
      .set({ status: 'running' })
      .where('id', '=', analysisId)
      .execute();
    expect(await runItemAnalysis(deps(), { accountId, analysisId })).toBe('succeeded');
  });

  it('fails visibly, with nothing billed, when a photo image is missing from storage', async () => {
    const { itemId, analysisId } = await queuedAnalysis(['front']);
    const photo = await db
      .selectFrom('photo')
      .select('derivatives')
      .where('item_id', '=', itemId)
      .executeTakeFirstOrThrow();
    await storage.delete(parsePhotoDerivatives(photo.derivatives)?.ai.key ?? '');
    expect(await runItemAnalysis(deps(), { accountId, analysisId })).toBe('failed');
    expect(await analysisRow(analysisId)).toMatchObject({
      status: 'failed',
      error_code: 'photo_missing',
      error_retryable: false,
      attempts: 0,
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('records an unexpected error as a retryable failure instead of leaving it running', async () => {
    const { analysisId } = await queuedAnalysis(['front']);
    const broken = new LocalDiskStorage({
      rootDir,
      baseUrl: 'http://127.0.0.1:3000',
      signingSecret: 'analysis-test-secret-0123456789abcdefgh',
    });
    broken.get = () => Promise.reject(new Error('disk on fire'));
    expect(await runItemAnalysis(deps({ storage: broken }), { accountId, analysisId })).toBe(
      'failed',
    );
    expect(await analysisRow(analysisId)).toMatchObject({
      status: 'failed',
      error_code: 'internal_error',
      error_message: 'The analysis failed unexpectedly. Try again.',
      error_retryable: true,
    });
  });

  it('queues the premium analysis with the result when one is needed, and runs it on the first result', async () => {
    const { analysisId, hash } = await queuedAnalysis(['front']);
    fixtures[hash] = analysisFixture(answer({ looksVintage: true }));
    expect(await runItemAnalysis(deps(), { accountId, analysisId })).toBe('succeeded');
    expect(queued).toHaveLength(1);
    const premium = await analysisRow(queued[0]?.analysisId ?? '');
    expect(premium).toMatchObject({
      tier: 'premium',
      status: 'pending',
      model: 'claude-sonnet-5-5',
      escalated_from_analysis_id: analysisId,
    });

    expect(await runItemAnalysis(deps(), { accountId, analysisId: premium.id })).toBe('succeeded');
    const escalationRequest = provider.requests[1];
    expect(escalationRequest?.model).toBe('claude-sonnet-5-5');
    expect(JSON.parse(escalationRequest?.prompt ?? '{}')).toMatchObject({
      firstAnalysis: { needsEscalation: true, escalationReason: 'It looks vintage.' },
    });
    expect((await analysisRow(premium.id)).output).toMatchObject({ needsEscalation: false });
  });
});
