/**
 * Automated operations (decision D1): the worker hands automated steps to the browser runner,
 * the runner confirms them by read-back like an API step, and a step that meets a check
 * automation must not pass falls back to the user. The browser itself is the automation
 * package's; here an automation adapter over the fake marketplace stands in for it.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ConnectionAwareAdapter,
  createMercariAdapter,
  FakeMarketplaceAdapter,
  type AdapterContext,
  type AdapterLookup,
  type ConnectionRef,
  type ListingPayload,
  type ListingRef,
  type MarketplaceAdapter,
  type MarketplaceCapabilities,
  type OperationRequest,
  type Outcome,
  type RemoteListingState,
} from '@listora/marketplaces';

import { confirmOperationByUser } from './commands.ts';
import { AUTOMATION_OPERATION_TASK, OPERATION_TASK, operationJobKey } from './jobs.ts';
import { describeListingStatus } from './status-display.ts';
import { createEngineHarness, type EngineHarness, type ListingRow } from './test-support.ts';
import type { OperationRow } from './transitions.ts';

const SETTLED = ['succeeded', 'failed', 'needs_user_action'] as const;

/** The fake marketplace, driven "through a browser session": automation capabilities. */
class AutomatedFake implements MarketplaceAdapter {
  readonly id = 'mercari' as const;
  calls = 0;
  /** The next send meets a CAPTCHA and falls back to the user's task. */
  challengeNext = false;
  readonly #inner: FakeMarketplaceAdapter;
  readonly #assisted = createMercariAdapter();

  constructor(baseUrl: string) {
    this.#inner = new FakeMarketplaceAdapter({ marketplace: 'mercari', baseUrl });
  }

  capabilities(): MarketplaceCapabilities {
    return {
      ...this.#inner.capabilities(),
      connect: 'session',
      create: 'automation',
      updatePrice: 'automation',
      updateDetails: 'automation',
      delist: 'automation',
      relist: 'automation',
      markSold: 'not_needed',
      verifyRead: 'automation',
    };
  }

  buildPayload: MarketplaceAdapter['buildPayload'] = (item, variant) =>
    this.#assisted.buildPayload(item, variant);

  validate(payload: ListingPayload): ReturnType<MarketplaceAdapter['validate']> {
    return this.#assisted.validate(payload as never);
  }

  async execute(op: OperationRequest, ctx: AdapterContext): Promise<Outcome> {
    this.calls += 1;
    if (this.challengeNext) {
      this.challengeNext = false;
      return this.#assisted.execute(op as never);
    }
    const payload = op.payload as {
      title: string;
      description: string;
      price: { amountCents: number };
      photos: { url: string }[];
    } | null;
    return this.#inner.execute(
      {
        ...op,
        payload:
          payload === null
            ? null
            : {
                title: payload.title,
                description: payload.description,
                priceCents: payload.price.amountCents,
                currency: 'USD',
                photoUrls: payload.photos.map((photo) => photo.url),
              },
      },
      ctx,
    );
  }

  async readListing(ref: ListingRef, ctx: AdapterContext): Promise<RemoteListingState> {
    this.calls += 1;
    return this.#inner.readListing(ref, ctx);
  }

  healthCheck: MarketplaceAdapter['healthCheck'] = (ctx) => this.#inner.healthCheck(ctx);
}

describe('automated operations (real Postgres)', () => {
  let harness: EngineHarness;
  let automated: AutomatedFake;
  let adapters: AdapterLookup;

  beforeAll(async () => {
    harness = await createEngineHarness('automation');
    automated = new AutomatedFake(harness.fake.url);
    const mercari = new ConnectionAwareAdapter({
      assisted: createMercariAdapter(),
      automation: automated,
    });
    adapters = (marketplace) =>
      marketplace === 'mercari' ? mercari : harness.adapters(marketplace);
  });

  afterAll(async () => {
    await harness.close();
  });

  async function automatedListing(
    status: ConnectionRef['status'] = 'connected',
  ): Promise<ListingRow> {
    const connection = await harness.db
      .insertInto('marketplace_connection')
      .values({
        account_id: harness.accountId,
        marketplace: 'mercari',
        mode: 'automation',
        status,
        token_ciphertext: status === 'connected' ? Buffer.from('sealed session') : null,
      })
      .onConflict((conflict) =>
        conflict.columns(['account_id', 'marketplace', 'external_user_id']).doUpdateSet({
          status,
          token_ciphertext: status === 'connected' ? Buffer.from('sealed session') : null,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    const listing = await harness.createListing('mercari');
    return harness.db
      .updateTable('marketplace_listing')
      .set({ connection_id: connection.id })
      .where('id', '=', listing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async function jobTask(operationId: string): Promise<string | undefined> {
    const { rows } = await sql<{ task_identifier: string }>`
      select task_identifier from graphile_worker.jobs where key = ${operationJobKey(operationId)}
    `.execute(harness.db);
    return rows[0]?.task_identifier;
  }

  async function waitForTask(operationId: string, task: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while ((await jobTask(operationId)) !== task) {
      if (Date.now() > deadline) throw new Error(`operation ${operationId} job is not ${task}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function statusOf(listing: ListingRow, op: OperationRow): Promise<string> {
    const current = await harness.listing(listing.id);
    const latest = await harness.operation(op.id);
    return describeListingStatus({
      marketplace: 'mercari',
      listingStatus: current.status,
      operation: {
        kind: latest.kind,
        status: latest.status,
        attempts: latest.attempts,
        errorMessage: latest.error_message,
        successEvidence: latest.success_evidence,
      },
    }).label;
  }

  it('hands automated steps to the browser runner, which confirms them by read-back', async () => {
    let handovers = 0;
    const worker = await harness.startWorker({
      adapters,
      onAutomationHandover: () => {
        handovers += 1;
      },
    });
    const listing = await automatedListing();
    const created = await harness.enqueue(listing, 'create', {
      title: 'Automated jacket',
      priceCents: 4500,
    });
    expect(await jobTask(created.id)).toBe(OPERATION_TASK);
    await waitForTask(created.id, AUTOMATION_OPERATION_TASK);
    // The worker counted no attempt and never touched the browser.
    expect(await harness.operation(created.id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(automated.calls).toBe(0);
    expect(handovers).toBeGreaterThanOrEqual(1);

    const runner = await harness.startWorker({ adapters, role: 'automation' });
    expect(await harness.waitForStatus(created.id, SETTLED)).toMatchObject({
      status: 'succeeded',
      success_evidence: 'read_back',
    });
    expect(automated.calls).toBeGreaterThanOrEqual(2);
    const events = await harness.events(created.id);
    expect(events.find((event) => event.to_status === 'running')?.detail).toMatchObject({
      mode: 'automation',
    });
    expect(await harness.listing(listing.id)).toMatchObject({ status: 'active' });
    expect(await statusOf(listing, created)).toBe('Active (confirmed by Mercari)');

    // A later change on the listing takes the same way.
    const priced = await harness.enqueue(listing, 'price', { priceCents: 3900 });
    expect(await harness.waitForStatus(priced.id, SETTLED)).toMatchObject({
      status: 'succeeded',
      success_evidence: 'read_back',
    });
    expect(harness.fake.listings('mercari', listing.id)).toEqual([
      expect.objectContaining({ priceCents: 3900 }),
    ]);
    await runner.stop();
    await worker.stop();
  });

  it('falls back to the user when automation meets a check it must not pass', async () => {
    const worker = await harness.startWorker({ adapters });
    const runner = await harness.startWorker({ adapters, role: 'automation' });
    const listing = await automatedListing();
    automated.challengeNext = true;
    const created = await harness.enqueue(listing, 'create', {
      title: 'Challenged',
      priceCents: 1000,
    });
    expect(await harness.waitForStatus(created.id, SETTLED)).toMatchObject({
      status: 'needs_user_action',
    });
    const tasks = await harness.db
      .selectFrom('user_task')
      .select(['kind', 'status'])
      .where('operation_id', '=', created.id)
      .execute();
    expect(tasks).toEqual([{ kind: 'list_manually', status: 'open' }]);
    expect(harness.fake.listings('mercari', listing.id)).toEqual([]);
    expect(await statusOf(listing, created)).toBe('Action needed - list on Mercari');

    const userId = await harness.addMember(`owner-${created.id}`);
    await confirmOperationByUser(harness.db, {
      accountId: harness.accountId,
      operationId: created.id,
      userId,
    });
    expect(await harness.operation(created.id)).toMatchObject({
      status: 'succeeded',
      success_evidence: 'user_confirmation',
    });
    expect(await statusOf(listing, created)).toBe('Done (you confirmed)');
    await runner.stop();
    await worker.stop();
  });

  it('serves a connection that waits for a relink assisted, without starting the runner', async () => {
    let handovers = 0;
    const worker = await harness.startWorker({
      adapters,
      onAutomationHandover: () => {
        handovers += 1;
      },
    });
    const listing = await automatedListing('reauth_required');
    const calls = automated.calls;
    const ended = await harness.enqueue(listing, 'end', { status: 'ended' });
    expect(await harness.waitForStatus(ended.id, SETTLED)).toMatchObject({
      status: 'needs_user_action',
    });
    expect(handovers).toBe(0);
    expect(automated.calls).toBe(calls);
    expect(await statusOf(listing, ended)).toBe('Action needed - delist on Mercari');
    await worker.stop();
  });

  it('keeps the runner to its own steps, and the worker to its own', async () => {
    const runner = await harness.startWorker({ adapters, role: 'automation' });
    const listing = await harness.createListing('ebay');
    const created = await harness.enqueue(listing, 'create', {
      title: 'API item',
      priceCents: 2000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await harness.operation(created.id)).toMatchObject({ status: 'queued', attempts: 0 });
    await runner.stop();
    await expect(
      harness.startWorker({
        adapters,
        role: 'automation',
        scheduledTasks: [{ name: 'tick', schedule: '* * * * *', run: async () => undefined }],
      }),
    ).rejects.toThrow('runs no scheduled tasks');
    const worker = await harness.startWorker({ adapters });
    expect(await harness.waitForStatus(created.id, SETTLED)).toMatchObject({ status: 'succeeded' });
    await worker.stop();
  });
});
