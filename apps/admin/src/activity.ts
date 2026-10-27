/**
 * The operator's side of activity and sale detection (docs/features/activity.md): search one
 * timeline by account, item, SKU, operation, sale, marketplace, and time; explain one sale;
 * list each connection's sale-check health and its latest checks; and ask for, then read, a
 * read-only read of a seller's sold history, which proves a marketplace's sale check reads
 * their real sold items without acting on any of them.
 */
import { duration, loadActivity, loadSaleExplanation, type ActivityEntry } from '@listora/activity';
import { requestSaleHistoryRead } from '@listora/automation';
import type { Db, JsonValue, Marketplace } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { assertNever } from '@listora/shared';

import type { Command } from './args.ts';
import type { CommandContext } from './commands.ts';
import { CommandError } from './commands.ts';
import { formatFields, formatTable } from './format.ts';

type ActivityCommand = Extract<
  Command,
  {
    name: 'activity' | 'sale-why' | 'sale-checks' | 'sale-history-read' | 'sale-history-show';
  }
>;

export async function runActivityCommand(
  command: ActivityCommand,
  context: CommandContext,
): Promise<void> {
  const { db, write } = context;
  const print = (text: string) => {
    write(`${text}\n`);
  };
  const printJson = (value: unknown) => {
    print(JSON.stringify(value, null, 2));
  };

  switch (command.name) {
    case 'activity': {
      const { sku, ...rest } = command.filter;
      let itemId = rest.itemId;
      if (sku !== undefined) {
        const item = await db
          .selectFrom('inventory_item')
          .select('id')
          .where('account_id', '=', rest.accountId ?? '')
          .where('sku', '=', sku)
          .executeTakeFirst();
        if (item === undefined) throw new CommandError(`no item ${sku} in that account`);
        itemId = item.id;
      }
      const entries = await loadActivity(db, {
        ...rest,
        ...(itemId === undefined ? {} : { itemId }),
        limit: command.limit,
      });
      if (command.json) {
        printJson(entries);
        return;
      }
      print(entries.length === 0 ? 'Nothing recorded for that search.' : timeline(entries));
      return;
    }

    case 'sale-why': {
      const sale = await db
        .selectFrom('sale')
        .select('account_id')
        .where('id', '=', command.saleId)
        .executeTakeFirst();
      if (sale === undefined) throw new CommandError(`no sale ${command.saleId}`);
      const explanation = await loadSaleExplanation(db, {
        accountId: sale.account_id,
        saleId: command.saleId,
      });
      if (explanation === undefined) throw new CommandError(`no sale ${command.saleId}`);
      if (command.json) {
        printJson(explanation);
        return;
      }
      const { check } = explanation;
      print(
        formatFields([
          ['sale', `${explanation.saleId} (account ${sale.account_id})`],
          ['marketplace', MARKETPLACE_NAMES[explanation.marketplace]],
          ['order', explanation.externalOrderId ?? '-'],
          ['sold at', explanation.soldAt.toISOString()],
          ['reported at', explanation.reportedAt?.toISOString() ?? '-'],
          ['recorded at', explanation.recordedAt.toISOString()],
          ['found by', `${explanation.detectionSource}: ${explanation.detection}`],
          [
            'sale check',
            check === null
              ? '-'
              : `${check.id} on ${check.host}, ${check.startedAt.toISOString()}, saw ${String(check.ordersSeen ?? 0)} orders (${String(check.newOrders ?? 0)} new)${check.runId === null ? '' : `, run ${check.runId}`}`,
          ],
        ]),
      );
      print('\nDelists on the other marketplaces:');
      print(
        explanation.delists.length === 0
          ? '  none (no other listing could be live)'
          : formatTable(
              ['Marketplace', 'Status', 'Attempts', 'Started', 'Settled', 'Result', 'Id'],
              explanation.delists.map((delist) => [
                MARKETPLACE_NAMES[delist.marketplace],
                delist.status,
                delist.attempts === null ? '-' : String(delist.attempts),
                delist.startedAt.toISOString(),
                delist.settledAt?.toISOString() ?? '-',
                delist.result,
                delist.operationId ?? delist.taskId ?? '-',
              ]),
            ),
      );
      print(`\nTimeline:\n${timeline(explanation.entries)}`);
      return;
    }

    case 'sale-checks': {
      const schedules = await db
        .selectFrom('sale_check_schedule as schedule')
        .innerJoin('marketplace_connection as connection', (join) =>
          join
            .onRef('connection.account_id', '=', 'schedule.account_id')
            .onRef('connection.id', '=', 'schedule.connection_id'),
        )
        .select([
          'schedule.account_id',
          'schedule.connection_id',
          'schedule.marketplace',
          'schedule.health',
          'schedule.failures_in_a_row',
          'schedule.last_succeeded_at',
          'schedule.last_finished_at',
          'schedule.next_check_at',
          'schedule.last_error_message',
          'schedule.alerted_at',
          'connection.status',
          'connection.runs_on',
        ])
        .$if(command.accountId !== undefined, (q) =>
          q.where('schedule.account_id', '=', command.accountId ?? ''),
        )
        .$if(command.marketplace !== undefined, (q) =>
          q.where('schedule.marketplace', '=', command.marketplace ?? 'ebay'),
        )
        .orderBy('schedule.account_id')
        .orderBy('schedule.marketplace')
        .execute();
      const checks = await db
        .selectFrom('sale_check_run')
        .selectAll()
        .$if(command.accountId !== undefined, (q) =>
          q.where('account_id', '=', command.accountId ?? ''),
        )
        .$if(command.marketplace !== undefined, (q) =>
          q.where('marketplace', '=', command.marketplace ?? 'ebay'),
        )
        .orderBy('started_at', 'desc')
        .limit(command.limit)
        .execute();
      if (command.json) {
        printJson({ schedules, checks });
        return;
      }
      if (schedules.length === 0) {
        print('No automation connection has sale checks.');
        return;
      }
      print(
        formatTable(
          [
            'Account',
            'Marketplace',
            'Connection',
            'Runs on',
            'Health',
            'Failed in a row',
            'Last worked',
            'Last ran',
            'Next due',
            'Told seller',
            'Last error',
          ],
          schedules.map((row) => [
            row.account_id,
            MARKETPLACE_NAMES[row.marketplace],
            row.status,
            row.runs_on,
            row.health,
            String(row.failures_in_a_row),
            row.last_succeeded_at?.toISOString() ?? 'never',
            row.last_finished_at?.toISOString() ?? 'never',
            row.next_check_at.toISOString(),
            row.alerted_at?.toISOString() ?? '-',
            row.last_error_message ?? '-',
          ]),
          [5],
        ),
      );
      if (checks.length === 0) return;
      print(
        `\nLatest checks:\n${formatTable(
          [
            'Started',
            'Marketplace',
            'Kind',
            'Host',
            'Took',
            'Outcome',
            'Orders',
            'New',
            'Error',
            'Id',
          ],
          checks.map((check) => [
            check.started_at.toISOString(),
            MARKETPLACE_NAMES[check.marketplace],
            check.kind,
            check.host,
            check.finished_at === null
              ? 'running'
              : duration(check.finished_at.getTime() - check.started_at.getTime()),
            check.outcome ?? 'running',
            check.orders_seen === null ? '-' : String(check.orders_seen),
            check.new_orders === null ? '-' : String(check.new_orders),
            check.error_message ?? '-',
            check.id,
          ]),
          [6, 7],
        )}`,
      );
      return;
    }

    case 'sale-history-read': {
      const requested = await requestSaleHistoryRead(db, command);
      const name = MARKETPLACE_NAMES[command.marketplace];
      if (requested === null) {
        throw new CommandError(
          `account ${command.accountId} has no working ${name} automation connection to read`,
        );
      }
      context.logger.info(
        {
          event: 'sale_history_requested',
          accountId: command.accountId,
          marketplace: command.marketplace,
          connectionId: requested.connectionId,
          queued: requested.queued,
        },
        'sale history read requested',
      );
      print(
        `${requested.queued ? 'Asked for' : 'Already waiting:'} a read-only read of the ${name} sold history (connection ${requested.connectionId}). ` +
          (requested.runsOn === 'phone'
            ? 'It runs on the seller’s iPhone the next time Listora is open there.'
            : 'The cloud browser runs it shortly.') +
          ` Then: npm run admin -- sale-history show ${command.marketplace} --account ${command.accountId}`,
      );
      return;
    }

    case 'sale-history-show': {
      const check = await newestHistoryRead(db, command);
      const name = MARKETPLACE_NAMES[command.marketplace];
      if (check === undefined) {
        throw new CommandError(`no ${name} sold history read for account ${command.accountId}`);
      }
      if (command.json) {
        printJson(check);
        return;
      }
      print(
        formatFields([
          ['read', check.id],
          ['host', check.host],
          ['started', check.started_at.toISOString()],
          ['finished', check.finished_at?.toISOString() ?? 'still running'],
          ['outcome', check.outcome ?? 'running'],
          ['sold orders seen', check.orders_seen === null ? '-' : String(check.orders_seen)],
          ['items seen', check.items_seen === null ? '-' : String(check.items_seen)],
          ['newest sale', check.newest_sold_at?.toISOString() ?? '-'],
          ['oldest sale', check.oldest_sold_at?.toISOString() ?? '-'],
          ['browser session', check.automation_run_id ?? '-'],
          ['error', check.error_message ?? '-'],
        ]),
      );
      const orders = soldOrders(check.orders);
      if (orders.length > 0) {
        print(
          `\n${formatTable(
            ['Sold at', 'Order', 'Listing', 'Price', 'Title'],
            orders.map((order) => [
              order.soldAt,
              order.orderId,
              order.listingId,
              order.price,
              order.title,
            ]),
            [3],
          )}`,
        );
      }
      return;
    }

    default:
      assertNever(command);
  }
}

async function newestHistoryRead(db: Db, command: { accountId: string; marketplace: Marketplace }) {
  return db
    .selectFrom('sale_check_run')
    .selectAll()
    .where('account_id', '=', command.accountId)
    .where('marketplace', '=', command.marketplace)
    .where('kind', '=', 'history')
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
}

/** A timeline as text, one line per entry (and one per step of a browser session). */
function timeline(entries: readonly ActivityEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const marketplace = entry.marketplace === null ? '' : ` [${entry.marketplace}]`;
    const took = entry.durationMs === null ? '' : ` (${duration(entry.durationMs)})`;
    lines.push(
      `${entry.at.toISOString()}  ${entry.outcome.padEnd(11)}  ${entry.source.padEnd(13)}${marketplace} ${entry.title}${took}`,
    );
    if (entry.detail !== null) lines.push(`    ${entry.detail}`);
    if (entry.error !== null) lines.push(`    error ${entry.error.code}: ${entry.error.message}`);
    for (const step of entry.steps ?? []) {
      lines.push(
        `    - ${step.name}${step.durationMs === null ? '' : ` (${duration(step.durationMs)})`}`,
      );
    }
    const ids = [
      entry.operationId === null ? null : `operation ${entry.operationId}`,
      entry.itemId === null ? null : `item ${entry.itemId}`,
      entry.saleId === null ? null : `sale ${entry.saleId}`,
      typeof entry.reference?.runId === 'string' ? `run ${entry.reference.runId}` : null,
      typeof entry.reference?.saleCheckId === 'string'
        ? `check ${entry.reference.saleCheckId}`
        : null,
      entry.reference?.screenshot === true ? 'screenshot kept' : null,
    ].filter((id) => id !== null);
    if (ids.length > 0) lines.push(`    ${ids.join(', ')}`);
  }
  return lines.join('\n');
}

/** The sold orders a check recorded, one row per item. */
function soldOrders(
  orders: JsonValue,
): { soldAt: string; orderId: string; listingId: string; price: string; title: string }[] {
  if (!Array.isArray(orders)) return [];
  return orders.flatMap((order) => {
    if (typeof order !== 'object' || order === null || Array.isArray(order)) return [];
    const items = Array.isArray(order['items']) ? order['items'] : [];
    return items.flatMap((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
      const cents = typeof item['priceCents'] === 'number' ? item['priceCents'] : null;
      return [
        {
          soldAt: typeof order['soldAt'] === 'string' ? order['soldAt'] : '-',
          orderId: typeof order['orderId'] === 'string' ? order['orderId'] : '-',
          listingId: typeof item['listingId'] === 'string' ? item['listingId'] : '-',
          price: cents === null ? '-' : `$${(cents / 100).toFixed(2)}`,
          title: typeof item['title'] === 'string' ? item['title'] : '-',
        },
      ];
    });
  });
}
