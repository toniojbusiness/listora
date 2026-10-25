/**
 * The delist SLA against a real Postgres and the operation engine: a re-alert 10 minutes after
 * the sale and an escalation at 30, each once and only while something is not delisted or
 * confirmed; completion once every listing is; nothing for a canceled sale.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  confirmOperationByUser,
  startOperationWorker,
  type OperationWorker,
} from '@listora/operations';
import { PUSH_TASK } from '@listora/push';
import { createLogger } from '@listora/shared';

import { startAutoDelist } from './fan-out.ts';
import { loadDelistRuns } from './results.ts';
import { runDelistSla } from './sla.ts';
import { createDelistHarness, type DelistHarness } from './test-support.ts';

const logger = createLogger({ service: 'auto-delist-test', level: 'silent' });

describe('the delist SLA', () => {
  let harness: DelistHarness;
  let worker: OperationWorker;
  let userId: string;
  const fatalErrors: Error[] = [];

  beforeAll(async () => {
    harness = await createDelistHarness('auto_delist_sla');
    worker = await startOperationWorker({
      connectionString: harness.database.scratch.url,
      db: harness.db,
      adapters: harness.adapters,
      logger,
      concurrency: 2,
      pollIntervalMs: 20,
      onFatalError: (error) => fatalErrors.push(error),
    });
    const user = await harness.db
      .insertInto('app_user')
      .values({ auth_provider: 'dev', auth_subject: 'sla-seller' })
      .returning('id')
      .executeTakeFirstOrThrow();
    userId = user.id;
    await harness.db
      .insertInto('membership')
      .values({ account_id: harness.accountId, user_id: userId, role: 'owner' })
      .execute();
  });

  afterAll(async () => {
    await worker.stop();
    await harness.close();
    expect(fatalErrors).toEqual([]);
  });

  /** An item sold on eBay that is also listed, assisted, on Poshmark and Mercari. */
  async function soldItem() {
    const item = await harness.item('Vintage Nike windbreaker');
    const ebay = await harness.listing(item.id, 'ebay');
    await harness.listing(item.id, 'poshmark');
    await harness.listing(item.id, 'mercari');
    const saleId = await harness.sale('ebay', [{ itemId: item.id, listingId: ebay }]);
    const [start] = await startAutoDelist(
      harness.db,
      {
        accountId: harness.accountId,
        saleId,
        marketplace: 'ebay',
        detectionSource: 'webhook',
        items: [{ itemId: item.id, listingId: ebay }],
      },
      { adapters: harness.adapters },
    );
    if (start?.type !== 'delist_started') throw new Error('no run');
    const runId = start.delistRunId;
    // The engine turns each assisted delist into an urgent task for the seller.
    await waitFor(async () => {
      const [run] = await view(runId);
      return run?.results.every((result) => result.state === 'needs_user_action') ?? false;
    });
    return { item, saleId, runId };
  }

  const view = (runId: string) =>
    loadDelistRuns(harness.db, harness.accountId, { runIds: [runId] });
  const stored = (runId: string) =>
    harness.db
      .selectFrom('delist_run')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
  /** Moves the run's start back, as if the sale happened `minutes` ago. */
  const ago = (runId: string, minutes: number) =>
    sql`update delist_run set created_at = now() - make_interval(mins => ${minutes}) where id = ${runId}`.execute(
      harness.db,
    );
  const pushes = async (runId: string) =>
    (await harness.jobs(PUSH_TASK))
      .filter((job) => job.key?.endsWith(`:${runId}`) === true)
      .map((job) => job.payload);
  const sla = () => runDelistSla({ db: harness.db, logger });

  it('re-alerts after 10 minutes and escalates after 30, once each', async () => {
    const { runId } = await soldItem();
    await sla();
    expect((await stored(runId)).realerted_at).toBeNull();
    expect(await pushes(runId)).toHaveLength(1);

    await ago(runId, 11);
    expect(await sla()).toMatchObject({ realerted: 1, escalated: 0 });
    const afterReminder = await stored(runId);
    expect(afterReminder).toMatchObject({ status: 'attention_needed', escalated_at: null });
    expect(afterReminder.realerted_at).toBeInstanceOf(Date);
    expect(await pushes(runId)).toContainEqual(
      expect.objectContaining({
        category: 'delist_reminder',
        title: 'Still listed: Vintage Nike windbreaker',
        body: 'It sold on eBay 10 minutes ago. Delist it on Mercari and Poshmark now.',
      }),
    );
    expect(await sla()).toMatchObject({ realerted: 0, escalated: 0 });

    await ago(runId, 31);
    expect(await sla()).toMatchObject({ realerted: 0, escalated: 1 });
    expect(await pushes(runId)).toContainEqual(
      expect.objectContaining({
        category: 'delist_escalation',
        title: 'Double-sale risk: Vintage Nike windbreaker',
      }),
    );
    const [run] = await view(runId);
    expect(run).toMatchObject({ status: 'attention_needed', escalated: true });
    expect(await sla()).toMatchObject({ realerted: 0, escalated: 0 });
    expect(await pushes(runId)).toHaveLength(3);
  });

  it('completes the run once the seller confirmed every delist, and the item is sold', async () => {
    const { item, runId } = await soldItem();
    await ago(runId, 45);
    await sla();
    const [run] = await view(runId);
    for (const result of run?.results ?? []) {
      await confirmOperationByUser(harness.db, {
        accountId: harness.accountId,
        operationId: result.operationId,
        userId,
      });
    }
    const [done] = await view(runId);
    expect(done).toMatchObject({
      status: 'completed',
      escalated: false,
      display: { tone: 'success', label: 'Delisted everywhere' },
    });
    expect(done?.results.map((result) => result.display.label)).toEqual([
      'Done (you confirmed)',
      'Done (you confirmed)',
    ]);

    expect(await sla()).toMatchObject({ completed: 1 });
    expect(await stored(runId)).toMatchObject({ status: 'completed' });
    expect((await stored(runId)).completed_at).toBeInstanceOf(Date);
    const { status } = await harness.db
      .selectFrom('inventory_item')
      .select('status')
      .where('id', '=', item.id)
      .executeTakeFirstOrThrow();
    expect(status).toBe('sold');
    const audit = await harness.db
      .selectFrom('audit_log')
      .select('action')
      .where('item_id', '=', item.id)
      .orderBy('created_at')
      .execute();
    expect(audit.map((entry) => entry.action)).toEqual(['item.sold', 'item.delisted']);
  });

  it('escalates a run first seen after 30 minutes without a separate reminder', async () => {
    const { runId } = await soldItem();
    await ago(runId, 40);
    expect(await sla()).toMatchObject({ realerted: 0, escalated: 1 });
    const run = await stored(runId);
    expect(run.realerted_at).toBeInstanceOf(Date);
    expect(run.escalated_at).toBeInstanceOf(Date);
    expect((await pushes(runId)).map((push) => push['category'])).toEqual([
      'item_sold',
      'delist_escalation',
    ]);
  });

  it('raises no alert for a sale that was canceled', async () => {
    const { saleId, runId } = await soldItem();
    await harness.db
      .updateTable('sale')
      .set({ status: 'canceled' })
      .where('id', '=', saleId)
      .execute();
    await ago(runId, 40);
    await sla();
    expect(await stored(runId)).toMatchObject({
      status: 'attention_needed',
      realerted_at: null,
      escalated_at: null,
    });
    expect(await pushes(runId)).toHaveLength(1);
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
