/**
 * The activity timeline (docs/features/activity.md): one list, newest first, of everything the
 * records say happened to an item, an operation, a sale, or an account's marketplace, from the
 * server (operation steps, the sale intake, the auto-delist, tasks, item changes), the browser
 * runner and the phone (each browser session with its steps and their times), and the sale
 * checks (what each read). It is read from the records that already hold the truth, never
 * stored twice, and it shows only what they keep: redacted excerpts, step names, codes, and the
 * ids operators search the logs by, never page content, typed values, or buyer data.
 */
import { sql } from 'kysely';

import type { DbExecutor, JsonArray, JsonValue, Marketplace } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';

import type { ActivityEntry, ActivityStep } from './entry.ts';
import {
  browserSessionDetail,
  browserSessionOutcome,
  browserSessionTitle,
  dollars,
  hostSource,
  itemChangeTitle,
  operationEventError,
  operationEventMessage,
  operationEventOutcome,
  operationEventSource,
  operationTitle,
  orderDetail,
  orderSource,
  orderTitle,
  saleCheckDetail,
  saleCheckTitle,
  saleDetectionWords,
  taskTitle,
} from './words.ts';

/** What a timeline is about. Without an item, operation, or sale, it is the account's (or all). */
export interface ActivityFilter {
  /** Required for anything a seller sees; an operator's search may leave it out. */
  accountId?: string;
  itemId?: string;
  operationId?: string;
  saleId?: string;
  marketplace?: Marketplace;
  /** Entries at or after this time. */
  from?: Date;
  /** Entries before this time (the next page of a timeline starts at its last entry). */
  to?: Date;
  /** At most this many entries, newest first. */
  limit: number;
}

type Scope = 'operation' | 'item' | 'sale' | 'all';

function scopeOf(filter: ActivityFilter): Scope {
  if (filter.operationId !== undefined) return 'operation';
  if (filter.itemId !== undefined) return 'item';
  if (filter.saleId !== undefined) return 'sale';
  return 'all';
}

/** The timeline the filter names, newest first. */
export async function loadActivity(
  db: DbExecutor,
  filter: ActivityFilter,
): Promise<ActivityEntry[]> {
  const scope = scopeOf(filter);
  const sources: Promise<ActivityEntry[]>[] = [
    operationEvents(db, filter),
    browserSessions(db, filter, scope),
    tasks(db, filter),
  ];
  if (scope !== 'operation') {
    sources.push(sales(db, filter), saleChecks(db, filter, scope), delistRuns(db, filter));
    if (filter.marketplace === undefined || scope !== 'all') sources.push(itemChanges(db, filter));
  }
  if (scope === 'sale' || scope === 'all') sources.push(orders(db, filter));
  const entries = (await Promise.all(sources)).flat();
  return entries
    .sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id))
    .slice(0, filter.limit);
}

/** Delist runs of the filter's sale, which its delist operations belong to. */
function saleDelistRuns(db: DbExecutor, filter: ActivityFilter) {
  return db
    .selectFrom('delist_run')
    .select('delist_run.id')
    .where('delist_run.sale_id', '=', filter.saleId ?? '')
    .$if(filter.accountId !== undefined, (query) =>
      query.where('delist_run.account_id', '=', filter.accountId ?? ''),
    );
}

async function operationEvents(db: DbExecutor, filter: ActivityFilter): Promise<ActivityEntry[]> {
  const rows = await db
    .selectFrom('operation_event as event')
    .innerJoin('marketplace_operation as op', (join) =>
      join
        .onRef('op.account_id', '=', 'event.account_id')
        .onRef('op.id', '=', 'event.operation_id'),
    )
    .innerJoin('marketplace_listing as listing', (join) =>
      join
        .onRef('listing.account_id', '=', 'op.account_id')
        .onRef('listing.id', '=', 'op.listing_id'),
    )
    .select([
      'event.id',
      'event.from_status',
      'event.to_status',
      'event.attempt',
      'event.error_code',
      'event.detail',
      'event.created_at',
      'op.id as operation_id',
      'op.kind',
      'op.origin',
      'listing.id as listing_id',
      'listing.item_id',
      'listing.marketplace',
    ])
    .$if(filter.accountId !== undefined, (q) =>
      q.where('event.account_id', '=', filter.accountId ?? ''),
    )
    .$if(filter.operationId !== undefined, (q) => q.where('op.id', '=', filter.operationId ?? ''))
    .$if(filter.itemId !== undefined, (q) => q.where('listing.item_id', '=', filter.itemId ?? ''))
    .$if(filter.saleId !== undefined && filter.operationId === undefined, (q) =>
      q.where('op.delist_run_id', 'in', saleDelistRuns(db, filter)),
    )
    .$if(filter.marketplace !== undefined, (q) =>
      q.where('listing.marketplace', '=', filter.marketplace ?? 'ebay'),
    )
    .$if(filter.from !== undefined, (q) =>
      q.where('event.created_at', '>=', filter.from ?? new Date(0)),
    )
    .$if(filter.to !== undefined, (q) => q.where('event.created_at', '<', filter.to ?? new Date()))
    .orderBy('event.created_at', 'desc')
    .orderBy('event.id', 'desc')
    .limit(filter.limit)
    .execute();
  return rows.map((row) => {
    const message = operationEventMessage(row, row.marketplace);
    const errorMessage = operationEventError(row.detail);
    return {
      ...blank(`operation:${row.id}`, row.created_at),
      kind: 'operation',
      source: operationEventSource(row),
      outcome: operationEventOutcome(row.to_status),
      marketplace: row.marketplace,
      title: operationTitle(row.kind, row.origin, row.marketplace),
      detail: message,
      itemId: row.item_id,
      listingId: row.listing_id,
      operationId: row.operation_id,
      error:
        row.error_code === null ? null : { code: row.error_code, message: errorMessage ?? message },
    };
  });
}

async function browserSessions(
  db: DbExecutor,
  filter: ActivityFilter,
  scope: Scope,
): Promise<ActivityEntry[]> {
  const rows = await db
    .selectFrom('automation_run as run')
    .leftJoin('marketplace_operation as op', (join) =>
      join.onRef('op.account_id', '=', 'run.account_id').onRef('op.id', '=', 'run.operation_id'),
    )
    .leftJoin('marketplace_listing as listing', (join) =>
      join
        .onRef('listing.account_id', '=', 'op.account_id')
        .onRef('listing.id', '=', 'op.listing_id'),
    )
    .select([
      'run.id',
      'run.marketplace',
      'run.purpose',
      'run.script',
      'run.host',
      'run.started_at',
      'run.finished_at',
      'run.outcome',
      'run.failed_step',
      'run.error_code',
      'run.challenge_kind',
      'run.screenshot_key',
      'run.steps',
      'run.operation_id',
      'listing.id as listing_id',
      'listing.item_id',
    ])
    .$if(filter.accountId !== undefined, (q) =>
      q.where('run.account_id', '=', filter.accountId ?? ''),
    )
    // An item's, an operation's, or a sale's timeline shows the sessions of its operations;
    // the account's shows every session (sale checks and sign-in checks too).
    .$if(scope !== 'all', (q) => q.where('run.operation_id', 'is not', null))
    .$if(filter.operationId !== undefined, (q) =>
      q.where('run.operation_id', '=', filter.operationId ?? ''),
    )
    .$if(filter.itemId !== undefined, (q) => q.where('listing.item_id', '=', filter.itemId ?? ''))
    .$if(scope === 'sale', (q) => q.where('op.delist_run_id', 'in', saleDelistRuns(db, filter)))
    .$if(filter.marketplace !== undefined, (q) =>
      q.where('run.marketplace', '=', filter.marketplace ?? 'ebay'),
    )
    .$if(filter.from !== undefined, (q) =>
      q.where('run.started_at', '>=', filter.from ?? new Date(0)),
    )
    .$if(filter.to !== undefined, (q) => q.where('run.started_at', '<', filter.to ?? new Date()))
    .orderBy('run.started_at', 'desc')
    .orderBy('run.id', 'desc')
    .limit(filter.limit)
    .execute();
  return rows.map((row) => {
    const steps = runSteps(row.steps);
    const durationMs =
      row.finished_at === null ? null : row.finished_at.getTime() - row.started_at.getTime();
    const failed = row.outcome !== null && row.outcome !== 'succeeded';
    return {
      ...blank(`browser_session:${row.id}`, row.started_at),
      kind: 'browser_session',
      source: hostSource(row.host),
      outcome: browserSessionOutcome(row.outcome),
      marketplace: row.marketplace,
      title: browserSessionTitle(row),
      detail: browserSessionDetail({ ...row, steps: steps.length, durationMs }),
      itemId: row.item_id,
      listingId: row.listing_id,
      operationId: row.operation_id,
      durationMs,
      steps,
      error:
        failed && (row.error_code !== null || row.challenge_kind !== null)
          ? {
              code: row.challenge_kind ?? row.error_code ?? 'failed',
              message: browserSessionDetail({ ...row, steps: steps.length, durationMs }),
            }
          : null,
      reference: { runId: row.id, saleCheckId: null, screenshot: row.screenshot_key !== null },
    };
  });
}

async function saleChecks(
  db: DbExecutor,
  filter: ActivityFilter,
  scope: Scope,
): Promise<ActivityEntry[]> {
  // An item's or a sale's timeline shows the checks that saw its sales; the account's, all.
  const sawSale = db
    .selectFrom('sale')
    .select('sale.sale_check_run_id')
    .where('sale.sale_check_run_id', 'is not', null)
    .$if(filter.accountId !== undefined, (q) =>
      q.where('sale.account_id', '=', filter.accountId ?? ''),
    )
    .$if(filter.saleId !== undefined, (q) => q.where('sale.id', '=', filter.saleId ?? ''))
    .$if(filter.itemId !== undefined, (q) =>
      q.where('sale.id', 'in', (eb) =>
        eb
          .selectFrom('sale_item')
          .select('sale_item.sale_id')
          .where('sale_item.item_id', '=', filter.itemId ?? ''),
      ),
    );
  const rows = await db
    .selectFrom('sale_check_run as check')
    .select([
      'check.id',
      'check.marketplace',
      'check.kind',
      'check.host',
      'check.started_at',
      'check.finished_at',
      'check.outcome',
      'check.orders_seen',
      'check.new_orders',
      'check.error_code',
      'check.error_message',
      'check.automation_run_id',
    ])
    .$if(filter.accountId !== undefined, (q) =>
      q.where('check.account_id', '=', filter.accountId ?? ''),
    )
    .$if(scope !== 'all', (q) => q.where('check.id', 'in', sawSale))
    .$if(filter.marketplace !== undefined, (q) =>
      q.where('check.marketplace', '=', filter.marketplace ?? 'ebay'),
    )
    .$if(filter.from !== undefined, (q) =>
      q.where('check.started_at', '>=', filter.from ?? new Date(0)),
    )
    .$if(filter.to !== undefined, (q) => q.where('check.started_at', '<', filter.to ?? new Date()))
    .orderBy('check.started_at', 'desc')
    .orderBy('check.id', 'desc')
    .limit(filter.limit)
    .execute();
  return rows.map((row) => ({
    ...blank(`sale_check:${row.id}`, row.started_at),
    kind: 'sale_check',
    source: hostSource(row.host),
    outcome:
      row.outcome === null ? 'in_progress' : row.outcome === 'succeeded' ? 'succeeded' : 'failed',
    marketplace: row.marketplace,
    title: saleCheckTitle(row),
    detail: saleCheckDetail(row),
    durationMs:
      row.finished_at === null ? null : row.finished_at.getTime() - row.started_at.getTime(),
    error:
      row.error_code === null
        ? null
        : { code: row.error_code, message: row.error_message ?? 'It failed.' },
    reference: { runId: row.automation_run_id, saleCheckId: row.id, screenshot: false },
  }));
}

async function orders(db: DbExecutor, filter: ActivityFilter): Promise<ActivityEntry[]> {
  const rows = await db
    .selectFrom('inbound_event as event')
    .select([
      'event.id',
      'event.source',
      'event.marketplace',
      'event.payload',
      'event.result',
      'event.error_message',
      'event.created_at',
    ])
    .$if(filter.accountId !== undefined, (q) =>
      q.where('event.account_id', '=', filter.accountId ?? ''),
    )
    .$if(filter.saleId !== undefined, (q) =>
      q.where('event.id', 'in', (eb) =>
        eb
          .selectFrom('sale')
          .select('sale.inbound_event_id')
          .where('sale.id', '=', filter.saleId ?? '')
          .where('sale.inbound_event_id', 'is not', null),
      ),
    )
    .$if(filter.marketplace !== undefined, (q) =>
      q.where('event.marketplace', '=', filter.marketplace ?? 'ebay'),
    )
    .$if(filter.from !== undefined, (q) =>
      q.where('event.created_at', '>=', filter.from ?? new Date(0)),
    )
    .$if(filter.to !== undefined, (q) => q.where('event.created_at', '<', filter.to ?? new Date()))
    .orderBy('event.created_at', 'desc')
    .orderBy('event.id', 'desc')
    .limit(filter.limit)
    .execute();
  return rows.map((row) => {
    const orderId = payloadString(row.payload, 'externalOrderId');
    return {
      ...blank(`order:${row.id}`, row.created_at),
      kind: 'order',
      source: orderSource(row.source),
      outcome: row.result === null ? 'in_progress' : row.result === 'failed' ? 'failed' : 'info',
      marketplace: row.marketplace,
      title: orderTitle(row.source, row.marketplace, orderId),
      detail: orderDetail(row.result, row.error_message),
      error:
        row.result === 'failed'
          ? { code: 'order_unreadable', message: row.error_message ?? "Listora couldn't read it." }
          : null,
      reference:
        payloadString(row.payload, 'saleCheckRunId') === null
          ? null
          : {
              runId: null,
              saleCheckId: payloadString(row.payload, 'saleCheckRunId'),
              screenshot: false,
            },
    };
  });
}

async function sales(db: DbExecutor, filter: ActivityFilter): Promise<ActivityEntry[]> {
  const rows = await db
    .selectFrom('sale')
    .leftJoin('sale_check_run as check', (join) =>
      join
        .onRef('check.account_id', '=', 'sale.account_id')
        .onRef('check.id', '=', 'sale.sale_check_run_id'),
    )
    .select((eb) => [
      'sale.id',
      'sale.marketplace',
      'sale.external_order_id',
      'sale.detection_source',
      'sale.sold_at',
      'sale.created_at',
      'sale.sale_check_run_id',
      'check.host as check_host',
      eb
        .selectFrom('sale_item')
        .select(sql<number>`coalesce(sum(sale_item.sale_price_cents), 0)::bigint`.as('total'))
        .whereRef('sale_item.account_id', '=', 'sale.account_id')
        .whereRef('sale_item.sale_id', '=', 'sale.id')
        .as('total_cents'),
      eb
        .selectFrom('sale_item')
        .select('sale_item.item_id')
        .whereRef('sale_item.account_id', '=', 'sale.account_id')
        .whereRef('sale_item.sale_id', '=', 'sale.id')
        .orderBy('sale_item.id')
        .limit(1)
        .as('first_item_id'),
    ])
    .$if(filter.accountId !== undefined, (q) =>
      q.where('sale.account_id', '=', filter.accountId ?? ''),
    )
    .$if(filter.saleId !== undefined, (q) => q.where('sale.id', '=', filter.saleId ?? ''))
    .$if(filter.itemId !== undefined, (q) =>
      q.where('sale.id', 'in', (eb) =>
        eb
          .selectFrom('sale_item')
          .select('sale_item.sale_id')
          .where('sale_item.item_id', '=', filter.itemId ?? ''),
      ),
    )
    .$if(filter.marketplace !== undefined, (q) =>
      q.where('sale.marketplace', '=', filter.marketplace ?? 'ebay'),
    )
    .$if(filter.from !== undefined, (q) =>
      q.where('sale.created_at', '>=', filter.from ?? new Date(0)),
    )
    .$if(filter.to !== undefined, (q) => q.where('sale.created_at', '<', filter.to ?? new Date()))
    .orderBy('sale.created_at', 'desc')
    .orderBy('sale.id', 'desc')
    .limit(filter.limit)
    .execute();
  return rows.map((row) => {
    const total = row.total_cents ?? 0;
    const order = row.external_order_id === null ? '' : ` (order ${row.external_order_id})`;
    return {
      ...blank(`sale:${row.id}`, row.created_at),
      kind: 'sale',
      source: row.detection_source === 'manual' ? 'you' : 'marketplace',
      outcome: 'info',
      marketplace: row.marketplace,
      title: `Sold on ${MARKETPLACE_NAMES[row.marketplace]} for ${dollars(total)}${order}`,
      detail: saleDetectionWords(
        row.detection_source,
        row.marketplace,
        row.check_host === null ? null : { host: row.check_host },
      ),
      itemId: filter.itemId ?? row.first_item_id ?? null,
      saleId: row.id,
      reference:
        row.sale_check_run_id === null
          ? null
          : { runId: null, saleCheckId: row.sale_check_run_id, screenshot: false },
    };
  });
}

async function delistRuns(db: DbExecutor, filter: ActivityFilter): Promise<ActivityEntry[]> {
  if (
    filter.marketplace !== undefined &&
    filter.itemId === undefined &&
    filter.saleId === undefined
  )
    return [];
  const rows = await db
    .selectFrom('delist_run as run')
    .innerJoin('sale', (join) =>
      join.onRef('sale.account_id', '=', 'run.account_id').onRef('sale.id', '=', 'run.sale_id'),
    )
    .select([
      'run.id',
      'run.item_id',
      'run.sale_id',
      'run.status',
      'run.created_at',
      'run.completed_at',
      'run.realerted_at',
      'run.escalated_at',
      'sale.marketplace',
    ])
    .$if(filter.accountId !== undefined, (q) =>
      q.where('run.account_id', '=', filter.accountId ?? ''),
    )
    .$if(filter.itemId !== undefined, (q) => q.where('run.item_id', '=', filter.itemId ?? ''))
    .$if(filter.saleId !== undefined, (q) => q.where('run.sale_id', '=', filter.saleId ?? ''))
    .$if(filter.from !== undefined, (q) =>
      q.where('run.created_at', '>=', filter.from ?? new Date(0)),
    )
    .$if(filter.to !== undefined, (q) => q.where('run.created_at', '<', filter.to ?? new Date()))
    .orderBy('run.created_at', 'desc')
    .limit(filter.limit)
    .execute();
  return rows.flatMap((row) => {
    const name = MARKETPLACE_NAMES[row.marketplace];
    const base = { itemId: row.item_id, saleId: row.sale_id, marketplace: row.marketplace };
    const entries: ActivityEntry[] = [
      {
        ...blank(`delist:${row.id}`, row.created_at),
        ...base,
        kind: 'delist',
        source: 'listora',
        outcome: row.status === 'completed' ? 'info' : 'in_progress',
        title: 'Delisting it everywhere else',
        detail: `It sold on ${name}, so Listora started delisting it on the other marketplaces.`,
      },
    ];
    for (const [at, id, title] of [
      [row.realerted_at, 'realert', 'Delist still not done: reminded you'],
      [row.escalated_at, 'escalate', 'Delist still not done after 30 minutes'],
    ] as const) {
      if (at === null) continue;
      entries.push({
        ...blank(`delist:${row.id}:${id}`, at),
        ...base,
        kind: 'delist',
        source: 'listora',
        outcome: 'waiting',
        title,
        detail: null,
      });
    }
    if (row.completed_at !== null) {
      entries.push({
        ...blank(`delist:${row.id}:done`, row.completed_at),
        ...base,
        kind: 'delist',
        source: 'listora',
        outcome: 'succeeded',
        title: 'Delisted everywhere else',
        detail: null,
      });
    }
    return entries.filter(
      (entry) =>
        (filter.from === undefined || entry.at >= filter.from) &&
        (filter.to === undefined || entry.at < filter.to),
    );
  });
}

async function tasks(db: DbExecutor, filter: ActivityFilter): Promise<ActivityEntry[]> {
  const rows = await db
    .selectFrom('user_task as task')
    .leftJoin('marketplace_listing as listing', (join) =>
      join
        .onRef('listing.account_id', '=', 'task.account_id')
        .onRef('listing.id', '=', 'task.listing_id'),
    )
    .select([
      'task.id',
      'task.kind',
      'task.status',
      'task.item_id',
      'task.listing_id',
      'task.operation_id',
      'task.sale_id',
      'task.created_at',
      'task.completed_at',
      'task.updated_at',
      'listing.marketplace',
    ])
    .$if(filter.accountId !== undefined, (q) =>
      q.where('task.account_id', '=', filter.accountId ?? ''),
    )
    .$if(filter.operationId !== undefined, (q) =>
      q.where('task.operation_id', '=', filter.operationId ?? ''),
    )
    .$if(filter.itemId !== undefined, (q) => q.where('task.item_id', '=', filter.itemId ?? ''))
    .$if(filter.saleId !== undefined && filter.operationId === undefined, (q) =>
      q.where((eb) =>
        eb.or([
          eb('task.sale_id', '=', filter.saleId ?? ''),
          eb('task.delist_run_id', 'in', saleDelistRuns(db, filter)),
        ]),
      ),
    )
    .$if(filter.marketplace !== undefined, (q) =>
      q.where('listing.marketplace', '=', filter.marketplace ?? 'ebay'),
    )
    .$if(filter.from !== undefined, (q) =>
      q.where('task.updated_at', '>=', filter.from ?? new Date(0)),
    )
    .$if(filter.to !== undefined, (q) => q.where('task.created_at', '<', filter.to ?? new Date()))
    .orderBy('task.created_at', 'desc')
    .limit(filter.limit)
    .execute();
  return rows.flatMap((row) => {
    const base = {
      kind: 'task' as const,
      marketplace: row.marketplace,
      itemId: row.item_id,
      listingId: row.listing_id,
      operationId: row.operation_id,
      saleId: row.sale_id,
    };
    const entries: ActivityEntry[] = [
      {
        ...blank(`task:${row.id}`, row.created_at),
        ...base,
        source: 'listora',
        outcome: row.status === 'open' ? 'waiting' : 'info',
        title: taskTitle(row.kind, row.marketplace),
        detail: null,
      },
    ];
    if (row.status !== 'open') {
      entries.push({
        ...blank(`task:${row.id}:${row.status}`, row.completed_at ?? row.updated_at),
        ...base,
        source: 'you',
        outcome: row.status === 'done' ? 'succeeded' : 'info',
        title: row.status === 'done' ? 'You did it' : 'You dismissed it',
        detail: taskTitle(row.kind, row.marketplace).replace('Waiting for you: ', ''),
      });
    }
    return entries.filter(
      (entry) =>
        (filter.from === undefined || entry.at >= filter.from) &&
        (filter.to === undefined || entry.at < filter.to),
    );
  });
}

async function itemChanges(db: DbExecutor, filter: ActivityFilter): Promise<ActivityEntry[]> {
  const rows = await db
    .selectFrom('audit_log as audit')
    .select([
      'audit.id',
      'audit.item_id',
      'audit.actor_kind',
      'audit.action',
      'audit.changes',
      'audit.created_at',
    ])
    .where('audit.item_id', 'is not', null)
    .$if(filter.accountId !== undefined, (q) =>
      q.where('audit.account_id', '=', filter.accountId ?? ''),
    )
    .$if(filter.itemId !== undefined, (q) => q.where('audit.item_id', '=', filter.itemId ?? ''))
    .$if(filter.saleId !== undefined, (q) =>
      q.where(sql<string>`audit.changes->>'saleId'`, '=', filter.saleId ?? ''),
    )
    .$if(filter.marketplace !== undefined, (q) =>
      q.where(sql<string>`audit.changes->>'marketplace'`, '=', filter.marketplace ?? 'ebay'),
    )
    .$if(filter.from !== undefined, (q) =>
      q.where('audit.created_at', '>=', filter.from ?? new Date(0)),
    )
    .$if(filter.to !== undefined, (q) => q.where('audit.created_at', '<', filter.to ?? new Date()))
    .orderBy('audit.created_at', 'desc')
    .orderBy('audit.id', 'desc')
    .limit(filter.limit)
    .execute();
  return rows.map((row) => {
    const marketplace = row.changes['marketplace'];
    const saleId = row.changes['saleId'];
    return {
      ...blank(`item:${row.id}`, row.created_at),
      kind: 'item',
      source:
        row.actor_kind === 'user'
          ? 'you'
          : row.actor_kind === 'marketplace'
            ? 'marketplace'
            : 'listora',
      outcome: 'info',
      marketplace:
        typeof marketplace === 'string' && marketplace in MARKETPLACE_NAMES
          ? (marketplace as Marketplace)
          : null,
      title: itemChangeTitle(row.action, row.changes),
      detail: null,
      itemId: row.item_id,
      saleId: typeof saleId === 'string' ? saleId : null,
    };
  });
}

/** An entry with nothing but its id and time; each source fills in the rest. */
function blank(id: string, at: Date): ActivityEntry {
  return {
    id,
    at,
    kind: 'item',
    source: 'listora',
    outcome: 'info',
    marketplace: null,
    title: '',
    detail: null,
    itemId: null,
    listingId: null,
    operationId: null,
    saleId: null,
    durationMs: null,
    steps: null,
    error: null,
    reference: null,
  };
}

/** A browser session's steps, as `automation_run.steps` keeps them. */
export function runSteps(value: JsonArray | null): ActivityStep[] {
  if (value === null) return [];
  return value.flatMap((step) => {
    if (typeof step !== 'object' || step === null || Array.isArray(step)) return [];
    const { name, ms } = step;
    if (typeof name !== 'string') return [];
    return [{ name, durationMs: typeof ms === 'number' ? ms : null }];
  });
}

function payloadString(payload: JsonValue, key: string): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}
