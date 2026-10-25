/**
 * The sale lifecycle (docs/features/sales.md): a recorded sale is `detected`; the seller confirms
 * it, ships it, or records that it was canceled or returned.
 *
 * ```text
 * detected ──confirm──▶ confirmed ──mark_shipped──▶ shipped
 *    │  └────────mark_shipped────────────▲              │
 *    ├──cancel──▶ canceled ◀──cancel── confirmed        │
 *    └─ (no return before it is confirmed or shipped)   └──record_return──▶ returned
 *                          confirmed ──record_return──▶ returned
 * ```
 *
 * - **Shipped.** The sold items become `shipped`; the seller may record what the label cost.
 * - **Canceled or returned.** The sale no longer stands. Its delists that reached no marketplace
 *   yet are canceled (`cancelUnsentDelists`), so a listing the seller wants to keep is not
 *   ended after all; the rest finish, and their read-backs say what is true. Each item that has
 *   no other sale that stands goes back to `listed` (a listing is still active) or `ready`, and
 *   its relist decision is `pending`: Listora asks the seller whether to relist and where, and
 *   never relists by itself (the API's `decideSaleRelist` queues the relists the seller picks on
 *   the operation engine). A double-sale incident the sale was part of is resolved.
 *
 * Every change runs under the sale's lock, then the items' (in id order, the order the delist
 * fan-out locks them in), and is written to the items' audit log.
 */
import { sql } from 'kysely';

import {
  inTransaction,
  jsonb,
  type DbExecutor,
  type DbTransaction,
  type ItemStatus,
  type JsonObject,
  type SaleStatus,
} from '@listora/db';
import { cancelUnsentDelists } from '@listora/operations';

export const SALE_ACTIONS = ['confirm', 'mark_shipped', 'cancel', 'record_return'] as const;
export type SaleAction = (typeof SALE_ACTIONS)[number];

const SALE_ACTION_RULES = {
  confirm: { from: ['detected'], to: 'confirmed' },
  mark_shipped: { from: ['detected', 'confirmed'], to: 'shipped' },
  cancel: { from: ['detected', 'confirmed'], to: 'canceled' },
  record_return: { from: ['confirmed', 'shipped'], to: 'returned' },
} as const satisfies Record<SaleAction, { from: readonly SaleStatus[]; to: SaleStatus }>;

/** The actions a sale in `status` allows, in display order. */
export function availableSaleActions(status: SaleStatus): SaleAction[] {
  return SALE_ACTIONS.filter((action) =>
    (SALE_ACTION_RULES[action].from as readonly SaleStatus[]).includes(status),
  );
}

/** A sale whose status stands: it still sold the item. */
export const STANDING_SALE_STATUSES = [
  'detected',
  'confirmed',
  'shipped',
] as const satisfies readonly SaleStatus[];

export class SaleNotFoundError extends Error {
  constructor(saleId: string) {
    super(`sale ${saleId} not found`);
    this.name = 'SaleNotFoundError';
  }
}

/** The sale's status does not allow the action (or the relist was decided already). */
export class SaleStateError extends Error {
  /** Why, in words the seller reads. */
  readonly userMessage: string;

  constructor(userMessage: string) {
    super(userMessage);
    this.name = 'SaleStateError';
    this.userMessage = userMessage;
  }
}

export interface SaleChange {
  accountId: string;
  saleId: string;
  action: SaleAction;
  /** The person making the change, for the audit log. */
  userId: string | null;
  /** `mark_shipped` only: what the label cost outside the payout, when the seller knows it. */
  shippingCostCents?: number | null;
}

export interface SaleChangeResult {
  from: SaleStatus;
  to: SaleStatus;
  /** For a cancel or return: the items whose relist decision is now pending. */
  relistPending: string[];
  /** Delist operations stopped because the sale no longer stands. */
  canceledDelists: string[];
}

const ACTION_MESSAGES = {
  confirm: 'Only a new sale can be confirmed.',
  mark_shipped: 'This sale was already shipped, canceled, or returned.',
  cancel: 'A sale that shipped is returned, not canceled; one canceled or returned stays so.',
  record_return: 'Only a confirmed or shipped sale can be returned.',
} as const satisfies Record<SaleAction, string>;

export async function changeSale(
  executor: DbExecutor,
  change: SaleChange,
): Promise<SaleChangeResult> {
  return inTransaction(executor, async (trx) => {
    const sale = await trx
      .selectFrom('sale')
      .select(['id', 'status', 'marketplace'])
      .where('account_id', '=', change.accountId)
      .where('id', '=', change.saleId)
      .forUpdate()
      .executeTakeFirst();
    if (sale === undefined) throw new SaleNotFoundError(change.saleId);
    const rule = SALE_ACTION_RULES[change.action];
    if (!(rule.from as readonly SaleStatus[]).includes(sale.status)) {
      throw new SaleStateError(ACTION_MESSAGES[change.action]);
    }

    const at = sql<Date>`now()`;
    await trx
      .updateTable('sale')
      .set({
        status: rule.to,
        ...(rule.to === 'confirmed' ? { confirmed_at: at } : {}),
        ...(rule.to === 'shipped' ? { shipped_at: at } : {}),
        ...(rule.to === 'canceled' ? { canceled_at: at } : {}),
        ...(rule.to === 'returned' ? { returned_at: at } : {}),
        ...(change.shippingCostCents === undefined || change.shippingCostCents === null
          ? {}
          : { shipping_cost_cents: change.shippingCostCents }),
      })
      .where('account_id', '=', change.accountId)
      .where('id', '=', sale.id)
      .execute();

    const lines = await trx
      .selectFrom('sale_item')
      .innerJoin('inventory_item as item', (join) =>
        join
          .onRef('item.account_id', '=', 'sale_item.account_id')
          .onRef('item.id', '=', 'sale_item.item_id'),
      )
      .select(['sale_item.id', 'sale_item.item_id', 'item.status'])
      .where('sale_item.account_id', '=', change.accountId)
      .where('sale_item.sale_id', '=', sale.id)
      .orderBy('sale_item.item_id')
      .forNoKeyUpdate('item')
      .execute();

    const result: SaleChangeResult = {
      from: sale.status,
      to: rule.to,
      relistPending: [],
      canceledDelists: [],
    };
    for (const line of lines) {
      const audit = {
        saleId: sale.id,
        marketplace: sale.marketplace,
        sale: { from: sale.status, to: rule.to },
      };
      switch (rule.to) {
        case 'confirmed':
          await writeAudit(trx, change, line.item_id, 'sale.confirmed', audit);
          break;
        case 'shipped': {
          const next =
            line.status === 'sold' || line.status === 'sold_pending_delist' ? 'shipped' : null;
          if (next !== null) await setItemStatus(trx, change.accountId, line.item_id, next);
          await writeAudit(trx, change, line.item_id, 'item.shipped', {
            ...audit,
            ...(next === null ? {} : { status: { from: line.status, to: next } }),
          });
          break;
        }
        case 'canceled':
        case 'returned': {
          const undone = await undoItemSale(trx, change, sale.id, line);
          result.canceledDelists.push(...undone.canceledDelists);
          if (undone.relistPending) result.relistPending.push(line.item_id);
          await writeAudit(
            trx,
            change,
            line.item_id,
            rule.to === 'canceled' ? 'item.sale_canceled' : 'item.returned',
            {
              ...audit,
              canceledDelists: undone.canceledDelists,
              ...(undone.status === null
                ? {}
                : { status: { from: line.status, to: undone.status } }),
            },
          );
          break;
        }
      }
    }
    return result;
  });
}

/** The sale no longer stands for this item: see the module comment. */
async function undoItemSale(
  trx: DbTransaction,
  change: SaleChange,
  saleId: string,
  line: { id: string; item_id: string; status: ItemStatus },
): Promise<{ canceledDelists: string[]; relistPending: boolean; status: ItemStatus | null }> {
  const { accountId } = change;
  const canceledDelists: string[] = [];
  const runs = await trx
    .selectFrom('delist_run')
    .select('id')
    .where('account_id', '=', accountId)
    .where('sale_id', '=', saleId)
    .where('item_id', '=', line.item_id)
    .execute();
  for (const run of runs) {
    canceledDelists.push(
      ...(await cancelUnsentDelists(trx, {
        accountId,
        delistRunId: run.id,
        reason: `the sale was ${change.action === 'cancel' ? 'canceled' : 'returned'}`,
        detail: { saleId },
      })),
    );
  }

  // A double sale this sale was part of is settled: one of its orders no longer stands.
  await trx
    .updateTable('user_task')
    .set({ status: 'done', completed_at: sql<Date>`now()` })
    .where('account_id', '=', accountId)
    .where('kind', '=', 'resolve_double_sale')
    .where('item_id', '=', line.item_id)
    .where('status', '=', 'open')
    .where((eb) =>
      eb.or([eb('sale_id', '=', saleId), eb(sql<string>`payload->>'earlierSaleId'`, '=', saleId)]),
    )
    .execute();

  const otherSale = await trx
    .selectFrom('sale_item')
    .innerJoin('sale', (join) =>
      join
        .onRef('sale.account_id', '=', 'sale_item.account_id')
        .onRef('sale.id', '=', 'sale_item.sale_id'),
    )
    .select('sale.id')
    .where('sale_item.account_id', '=', accountId)
    .where('sale_item.item_id', '=', line.item_id)
    .where('sale.id', '<>', saleId)
    .where('sale.status', 'in', STANDING_SALE_STATUSES)
    .limit(1)
    .executeTakeFirst();
  // The item still sold in another order (a double sale): it stays sold, and there is nothing
  // to relist.
  if (otherSale !== undefined) return { canceledDelists, relistPending: false, status: null };

  const active = await trx
    .selectFrom('marketplace_listing')
    .select('id')
    .where('account_id', '=', accountId)
    .where('item_id', '=', line.item_id)
    .where('status', '=', 'active')
    .limit(1)
    .executeTakeFirst();
  const status: ItemStatus = active === undefined ? 'ready' : 'listed';
  await setItemStatus(trx, accountId, line.item_id, status);
  await trx
    .updateTable('sale_item')
    .set({ relist_decision: 'pending', relist_decided_at: null })
    .where('account_id', '=', accountId)
    .where('id', '=', line.id)
    .execute();
  return { canceledDelists, relistPending: true, status: line.status === status ? null : status };
}

/**
 * Records the seller's answer to "Relist it?" for one item of a canceled or returned sale. The
 * caller queues the relists it chose in the same transaction. Refused unless the decision is
 * pending, so a replayed or second answer never relists twice.
 */
export async function recordRelistDecision(
  trx: DbTransaction,
  decision: {
    accountId: string;
    saleId: string;
    itemId: string;
    decision: 'relisted' | 'declined';
    userId: string | null;
    listingIds: readonly string[];
  },
): Promise<void> {
  const line = await trx
    .selectFrom('sale_item')
    .select(['id', 'relist_decision'])
    .where('account_id', '=', decision.accountId)
    .where('sale_id', '=', decision.saleId)
    .where('item_id', '=', decision.itemId)
    .forUpdate()
    .executeTakeFirst();
  if (line === undefined) throw new SaleNotFoundError(decision.saleId);
  if (line.relist_decision !== 'pending') {
    throw new SaleStateError(
      line.relist_decision === null
        ? 'This sale still stands, so there is nothing to relist.'
        : 'You already decided whether to relist this item.',
    );
  }
  await trx
    .updateTable('sale_item')
    .set({ relist_decision: decision.decision, relist_decided_at: sql<Date>`now()` })
    .where('account_id', '=', decision.accountId)
    .where('id', '=', line.id)
    .execute();
  await writeAudit(
    trx,
    { accountId: decision.accountId, userId: decision.userId },
    decision.itemId,
    decision.decision === 'relisted' ? 'item.relist_chosen' : 'item.relist_declined',
    { saleId: decision.saleId, listingIds: [...decision.listingIds] },
  );
}

async function setItemStatus(
  trx: DbTransaction,
  accountId: string,
  itemId: string,
  status: ItemStatus,
): Promise<void> {
  await trx
    .updateTable('inventory_item')
    .set({ status, pre_archive_status: null })
    .where('account_id', '=', accountId)
    .where('id', '=', itemId)
    .execute();
}

async function writeAudit(
  trx: DbTransaction,
  actor: { accountId: string; userId: string | null },
  itemId: string,
  action: string,
  changes: JsonObject,
): Promise<void> {
  await trx
    .insertInto('audit_log')
    .values({
      account_id: actor.accountId,
      item_id: itemId,
      actor_kind: 'user',
      actor_user_id: actor.userId,
      action,
      changes: jsonb(changes),
    })
    .execute();
}
