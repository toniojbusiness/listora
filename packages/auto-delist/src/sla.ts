/**
 * The delist SLA (`auto_delist_sla`, every minute; docs/features/auto-delist.md). For every
 * run that is not completed, oldest first:
 *
 * - its stored status follows its results (`loadDelistRuns`), and a run whose every listing is
 *   delisted or confirmed is completed, which makes its item `sold`;
 * - 10 minutes after the sale, if anything is still not delisted or confirmed (still
 *   delisting, being checked, failed, or waiting for the seller), the seller is alerted again;
 * - 30 minutes after it, the alert escalates: a second push, and the run's `escalated` flag,
 *   which the app shows as a banner until the run completes.
 *
 * Each alert is sent once per run (`realerted_at`, `escalated_at`), queued in the transaction
 * that records it. Results the seller stopped (a canceled delist) and runs of a canceled or
 * returned sale raise no alerts. Runs are locked with `skip locked`, so two workers never
 * handle the same run.
 */
import { sql } from 'kysely';

import { inTransaction, jsonb, type Db, type DbTransaction } from '@listora/db';
import { enqueuePush } from '@listora/push';
import type { Logger } from '@listora/shared';

import { escalationNotification, itemLabel, reminderNotification } from './messages.ts';
import { ALERT_STATES, loadDelistRuns, type DelistResult, type DelistRunView } from './results.ts';

export const AUTO_DELIST_SLA_TASK = 'auto_delist_sla';
export const AUTO_DELIST_SLA_SCHEDULE = '* * * * *';

export const DELIST_SLA = {
  realertAfterMs: 10 * 60_000,
  escalateAfterMs: 30 * 60_000,
} as const;

export interface DelistSlaDependencies {
  db: Db;
  logger: Pick<Logger, 'info'>;
  now?: () => Date;
  /** Runs handled per transaction (default 100). */
  batchSize?: number;
}

export interface DelistSlaSummary {
  checked: number;
  completed: number;
  realerted: number;
  escalated: number;
}

export async function runDelistSla(deps: DelistSlaDependencies): Promise<DelistSlaSummary> {
  const now = deps.now ?? (() => new Date());
  const batchSize = deps.batchSize ?? 100;
  const summary: DelistSlaSummary = { checked: 0, completed: 0, realerted: 0, escalated: 0 };
  let after: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const last = await inTransaction(deps.db, async (trx) => {
      const rows = await trx
        .selectFrom('delist_run')
        .select(['id', 'account_id', 'status', 'created_at'])
        .where('status', '<>', 'completed')
        .$if(after !== null, (query) =>
          query.where(
            sql<boolean>`(created_at, id) > (${after?.createdAt ?? null}, ${after?.id ?? null})`,
          ),
        )
        .orderBy('created_at')
        .orderBy('id')
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .execute();
      const byAccount = new Map<string, string[]>();
      for (const row of rows) {
        byAccount.set(row.account_id, [...(byAccount.get(row.account_id) ?? []), row.id]);
      }
      const stored = new Map(rows.map((row) => [row.id, row.status]));
      for (const [accountId, runIds] of byAccount) {
        for (const run of await loadDelistRuns(trx, accountId, { runIds })) {
          const outcome = await checkRun(trx, run, stored.get(run.id), now());
          summary.checked += 1;
          if (outcome.completed) summary.completed += 1;
          if (outcome.realerted) summary.realerted += 1;
          if (outcome.escalated) summary.escalated += 1;
        }
      }
      const tail = rows.at(-1);
      return rows.length < batchSize || tail === undefined
        ? null
        : { createdAt: tail.created_at, id: tail.id };
    });
    if (last === null) break;
    after = last;
  }
  if (summary.realerted > 0 || summary.escalated > 0 || summary.completed > 0) {
    deps.logger.info({ ...summary, event: AUTO_DELIST_SLA_TASK }, 'delist runs checked');
  }
  return summary;
}

async function checkRun(
  trx: DbTransaction,
  run: DelistRunView,
  storedStatus: DelistRunView['status'] | undefined,
  now: Date,
): Promise<{ completed: boolean; realerted: boolean; escalated: boolean }> {
  const outcome = { completed: false, realerted: false, escalated: false };
  const update: {
    status?: DelistRunView['status'];
    completed_at?: Date;
    realerted_at?: Date;
    escalated_at?: Date;
  } = {};
  if (run.status !== storedStatus) update.status = run.status;

  if (run.status === 'completed') {
    update.completed_at = run.completedAt ?? now;
    await finishItem(trx, run);
    outcome.completed = true;
  } else if (run.saleStatus !== 'canceled' && run.saleStatus !== 'returned') {
    const open = run.results.filter((result) =>
      (ALERT_STATES as readonly DelistResult['state'][]).includes(result.state),
    );
    const age = now.getTime() - run.startedAt.getTime();
    if (open.length > 0 && run.escalatedAt === null && age >= DELIST_SLA.escalateAfterMs) {
      await alert(trx, run, open, 'escalation');
      update.escalated_at = now;
      if (run.realertedAt === null) update.realerted_at = now;
      outcome.escalated = true;
    } else if (open.length > 0 && run.realertedAt === null && age >= DELIST_SLA.realertAfterMs) {
      await alert(trx, run, open, 'reminder');
      update.realerted_at = now;
      outcome.realerted = true;
    }
  }

  if (Object.keys(update).length > 0) {
    await trx
      .updateTable('delist_run')
      .set(update)
      .where('account_id', '=', run.accountId)
      .where('id', '=', run.id)
      .execute();
  }
  return outcome;
}

async function alert(
  trx: DbTransaction,
  run: DelistRunView,
  open: readonly DelistResult[],
  kind: 'reminder' | 'escalation',
): Promise<void> {
  const item = await trx
    .selectFrom('inventory_item')
    .select(['sku', 'title'])
    .where('account_id', '=', run.accountId)
    .where('id', '=', run.itemId)
    .executeTakeFirstOrThrow();
  const context = {
    accountId: run.accountId,
    itemId: run.itemId,
    saleId: run.saleId,
    delistRunId: run.id,
    label: itemLabel(item),
    soldOn: run.soldOn,
  };
  const notification =
    kind === 'reminder'
      ? reminderNotification(context, open)
      : escalationNotification(context, open);
  await enqueuePush(trx, notification, { key: `delist_${kind}:${run.id}` });
}

/**
 * The item is `sold` once no run of its sales is still delisting. An item whose status moved on
 * meanwhile (shipped, archived) keeps it.
 */
async function finishItem(trx: DbTransaction, run: DelistRunView): Promise<void> {
  const finished = await trx
    .updateTable('inventory_item')
    .set({ status: 'sold' })
    .where('account_id', '=', run.accountId)
    .where('id', '=', run.itemId)
    .where('status', '=', 'sold_pending_delist')
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('delist_run as other')
            .select('other.id')
            .where('other.account_id', '=', run.accountId)
            .where('other.item_id', '=', run.itemId)
            .where('other.id', '<>', run.id)
            .where('other.status', '<>', 'completed'),
        ),
      ),
    )
    .returning('id')
    .executeTakeFirst();
  if (finished === undefined) return;
  await trx
    .insertInto('audit_log')
    .values({
      account_id: run.accountId,
      item_id: run.itemId,
      actor_kind: 'system',
      action: 'item.delisted',
      changes: jsonb({
        delistRunId: run.id,
        saleId: run.saleId,
        status: { from: 'sold_pending_delist', to: 'sold' },
      }),
    })
    .execute();
}
