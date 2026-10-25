/**
 * A sale's fee lines (`fee_line`, docs/features/sales.md):
 *
 * - **Estimated at once.** Recording a sale adds one estimated line per rule of the fee table
 *   in effect on the day it sold (`@listora/pricing`), computed on the order's sale price and
 *   charged to the order (not to one item), with the table's version. So every sale has a
 *   payout and a profit from the start, labeled as estimates.
 * - **Actual when the marketplace reports them.** For a sale with an order id on a marketplace
 *   whose adapter reads order fees (eBay's Finances API, Depop's order fee breakdown) under an
 *   API connection, the `sale_fees` job asks the marketplace; once it answers, the order's
 *   lines are replaced by the actual ones in one transaction, so a sale never mixes the two. A
 *   marketplace that has not recorded them yet, or fails for a while, is asked again later (2
 *   minutes, then 10, 1 hour, 6 hours, and 24 hours); after that, or when the marketplace will
 *   not report them, the sale keeps its estimate.
 */
import { accountConnections } from '@listora/connections';
import {
  addJob,
  inTransaction,
  type DbExecutor,
  type DbTransaction,
  type Marketplace,
} from '@listora/db';
import type { AdapterLookup, ConnectionRef, OrderFee } from '@listora/marketplaces';
import { estimateFeeLines, feeTableForSale } from '@listora/pricing';
import type { CurrencyCode, Logger } from '@listora/shared';

export const SALE_FEES_TASK = 'sale_fees';

/** How long after each unanswered check the next one runs; the last one is the final check. */
export const SALE_FEE_CHECK_DELAYS_MS = [
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

export interface SaleFeesPayload extends Record<string, string> {
  accountId: string;
  saleId: string;
  /** The check this job is: `1` for the first. */
  check: string;
}

export function isSaleFeesPayload(payload: unknown): payload is SaleFeesPayload {
  const value = (payload ?? {}) as Record<string, unknown>;
  return (
    typeof value['accountId'] === 'string' &&
    typeof value['saleId'] === 'string' &&
    typeof value['check'] === 'string' &&
    /^\d{1,3}$/.test(value['check'])
  );
}

/** The sale's estimated fee lines, from the fee table of the day it sold. */
export async function recordEstimatedFees(
  trx: DbTransaction,
  sale: {
    accountId: string;
    saleId: string;
    marketplace: Marketplace;
    soldAt: Date;
    currency: CurrencyCode;
    salePriceCents: number;
  },
): Promise<void> {
  const table = feeTableForSale(sale.marketplace, sale.soldAt);
  const lines = estimateFeeLines(table, sale.salePriceCents).filter(
    (line) => line.amountCents !== 0,
  );
  if (lines.length === 0) return;
  await trx
    .insertInto('fee_line')
    .values(
      lines.map((line) => ({
        account_id: sale.accountId,
        sale_id: sale.saleId,
        kind: line.kind,
        currency: sale.currency,
        amount_cents: line.amountCents,
        source: 'estimated' as const,
        description: line.name,
        fee_table_version: table.version,
      })),
    )
    .execute();
}

/**
 * Queues the first actual-fee check when the marketplace can report the order's fees: the sale
 * has an order id, and the account's connection to the marketplace runs through its API with
 * an adapter that reads order fees.
 */
export async function scheduleFeeCheck(
  trx: DbTransaction,
  sale: {
    accountId: string;
    saleId: string;
    marketplace: Marketplace;
    externalOrderId: string | null;
  },
  adapters: AdapterLookup,
): Promise<boolean> {
  if (sale.externalOrderId === null) return false;
  const connection = await apiConnection(trx, sale.accountId, sale.marketplace);
  const adapter = adapters(sale.marketplace);
  if (connection === null || adapter?.readOrderFees === undefined) return false;
  await queueCheck(trx, sale, 1, undefined);
  return true;
}

async function queueCheck(
  executor: DbExecutor,
  sale: { accountId: string; saleId: string },
  check: number,
  runAt: Date | undefined,
): Promise<void> {
  await addJob(executor, {
    task: SALE_FEES_TASK,
    payload: { accountId: sale.accountId, saleId: sale.saleId, check: String(check) },
    jobKey: `${SALE_FEES_TASK}:${sale.saleId}`,
    ...(runAt === undefined ? {} : { runAt }),
  });
}

async function apiConnection(
  db: DbExecutor,
  accountId: string,
  marketplace: Marketplace,
): Promise<ConnectionRef | null> {
  const connection = (await accountConnections(db, accountId)).get(marketplace);
  return connection?.mode === 'api'
    ? { id: connection.id, mode: 'api', status: connection.status }
    : null;
}

export interface SaleFeesDependencies {
  db: DbExecutor;
  adapters: AdapterLookup;
  logger: Logger;
  now?: () => Date;
}

export type SaleFeesOutcome =
  /** The order's lines are now the marketplace's actual fees. */
  | { type: 'recorded'; fees: number }
  /** Not reported yet, or a temporary failure: another check is queued. */
  | { type: 'rescheduled'; check: number; runAt: Date }
  /** The sale keeps its estimate: the marketplace won't report fees, or the checks ran out. */
  | { type: 'kept_estimate'; reason: string };

/** One fee check (the `sale_fees` job). */
export async function checkSaleFees(
  deps: SaleFeesDependencies,
  payload: SaleFeesPayload,
  signal: AbortSignal,
): Promise<SaleFeesOutcome> {
  const { db, adapters, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const check = Number(payload.check);
  const sale = await db
    .selectFrom('sale')
    .select(['id', 'account_id', 'marketplace', 'external_order_id'])
    .where('account_id', '=', payload.accountId)
    .where('id', '=', payload.saleId)
    .executeTakeFirst();
  if (sale?.external_order_id === null || sale === undefined) {
    return { type: 'kept_estimate', reason: 'the sale or its order id is gone' };
  }
  const connection = await apiConnection(db, sale.account_id, sale.marketplace);
  const adapter = adapters(sale.marketplace);
  if (connection === null || adapter?.readOrderFees === undefined) {
    return { type: 'kept_estimate', reason: 'no API connection reads this marketplace’s fees' };
  }

  const answer = await adapter.readOrderFees(sale.external_order_id, { signal, connection });
  const log = logger.child({ saleId: sale.id, marketplace: sale.marketplace, check });
  switch (answer.type) {
    case 'fees': {
      if (answer.fees.length === 0) {
        // Without a line, the sale would show no payout at all; the estimate stays.
        return { type: 'kept_estimate', reason: 'the marketplace reported no fees' };
      }
      // Adapters report US dollars only (USD is the one currency Listora records).
      await replaceWithActualFees(db, sale.account_id, sale.id, answer.fees);
      log.info({ fees: answer.fees.length }, 'recorded the actual fees of a sale');
      return { type: 'recorded', fees: answer.fees.length };
    }
    case 'unavailable':
      log.info({ code: answer.code }, 'the marketplace does not report this sale’s fees');
      return { type: 'kept_estimate', reason: answer.code };
    case 'not_yet':
    case 'transient': {
      const delay = SALE_FEE_CHECK_DELAYS_MS[check - 1];
      if (delay === undefined) {
        log.warn({ last: answer.type }, 'stopped checking a sale’s fees; it keeps the estimate');
        return { type: 'kept_estimate', reason: 'no answer after the last check' };
      }
      const retryAfter = answer.type === 'transient' ? (answer.retryAfterMs ?? 0) : 0;
      const runAt = new Date(now().getTime() + Math.max(delay, retryAfter));
      await queueCheck(db, { accountId: sale.account_id, saleId: sale.id }, check + 1, runAt);
      return { type: 'rescheduled', check: check + 1, runAt };
    }
  }
}

/**
 * Replaces the sale's order-level lines with the marketplace's fees, in one transaction under
 * the sale's lock, so the sale never shows a mix of estimated and actual lines.
 */
export async function replaceWithActualFees(
  executor: DbExecutor,
  accountId: string,
  saleId: string,
  fees: readonly OrderFee[],
): Promise<void> {
  await inTransaction(executor, async (trx) => {
    await trx
      .selectFrom('sale')
      .select('id')
      .where('account_id', '=', accountId)
      .where('id', '=', saleId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await trx
      .deleteFrom('fee_line')
      .where('account_id', '=', accountId)
      .where('sale_id', '=', saleId)
      .where('sale_item_id', 'is', null)
      .execute();
    if (fees.length === 0) return;
    await trx
      .insertInto('fee_line')
      .values(
        fees.map((fee) => ({
          account_id: accountId,
          sale_id: saleId,
          kind: fee.kind,
          currency: fee.currency,
          amount_cents: fee.amountCents,
          source: 'actual' as const,
          description: fee.description,
        })),
      )
      .execute();
  });
}
