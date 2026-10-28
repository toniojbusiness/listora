/**
 * The morning summary (`today_summary`, every 5 minutes; docs/features/today.md): once a day,
 * at the time each account chose in its own time zone, a push notification that sums up the
 * Today screen, through the push outbox. It is the same summary the app shows, so the two never
 * disagree; a day with nothing to do sends nothing.
 *
 * An account is due from its chosen time until `windowMinutes` later, so a worker that was down
 * for a while still sends it, but a summary is never sent hours late (or in the evening after
 * the seller turned it on). Each account's local date is claimed (`last_sent_on`) in the
 * transaction that queues its notification, so two workers, or two ticks, never send it twice.
 */
import { inTransaction, type Db } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { enqueuePush, type PushNotification } from '@listora/push';
import type { Logger } from '@listora/shared';
import { sql } from 'kysely';

import { formatMoney, type TodayCard } from './cards.ts';
import { loadToday, type TodaySummary } from './summary.ts';

export const TODAY_SUMMARY_TASK = 'today_summary';
export const TODAY_SUMMARY_SCHEDULE = '*/5 * * * *';
/** How long after its time an account's summary may still go out. */
export const TODAY_SUMMARY_WINDOW_MINUTES = 120;
export const TODAY_SUMMARY_CATEGORY = 'today_summary';

export interface MorningSummaryDependencies {
  db: Db;
  logger: Pick<Logger, 'info'>;
  now?: () => Date;
  /** Accounts claimed per transaction (default 50). */
  batchSize?: number;
}

export interface MorningSummaryResult {
  /** Accounts whose summary was due and is now done for their day. */
  claimed: number;
  /** Of those, the ones with something to do, which got a notification. */
  sent: number;
}

export async function runMorningSummaries(
  deps: MorningSummaryDependencies,
): Promise<MorningSummaryResult> {
  const now = deps.now?.() ?? new Date();
  const batchSize = deps.batchSize ?? 50;
  const result: MorningSummaryResult = { claimed: 0, sent: 0 };
  for (;;) {
    const batch = await inTransaction(deps.db, async (trx) => {
      const claimed = await sql<{ account_id: string; local_date: string }>`
        update today_summary_setting setting
        set last_sent_on = due.local_date
        from (
          select account_id, (${now}::timestamptz at time zone time_zone)::date as local_date
          from today_summary_setting
          where enabled and time_zone is not null
            and (${now}::timestamptz at time zone time_zone)
              >= (${now}::timestamptz at time zone time_zone)::date + local_time
            and (${now}::timestamptz at time zone time_zone)
              < (${now}::timestamptz at time zone time_zone)::date + local_time
                + make_interval(mins => ${TODAY_SUMMARY_WINDOW_MINUTES})
            and (last_sent_on is null
              or last_sent_on < (${now}::timestamptz at time zone time_zone)::date)
          order by account_id
          limit ${batchSize}
          for update skip locked
        ) due
        where setting.account_id = due.account_id
        returning setting.account_id, to_char(due.local_date, 'YYYY-MM-DD') as local_date
      `.execute(trx);
      let sent = 0;
      for (const row of claimed.rows) {
        const summary = await loadToday(trx, row.account_id, now);
        const notification = morningNotification(row.account_id, summary);
        if (notification === null) continue;
        await enqueuePush(trx, notification, {
          key: `today_summary:${row.account_id}:${row.local_date}`,
        });
        sent += 1;
      }
      return { claimed: claimed.rows.length, sent };
    });
    result.claimed += batch.claimed;
    result.sent += batch.sent;
    if (batch.claimed < batchSize) break;
  }
  if (result.claimed > 0) {
    deps.logger.info({ task: TODAY_SUMMARY_TASK, ...result }, 'morning summaries sent');
  }
  return result;
}

/** The summary's notification, or null when there is nothing to do today. */
export function morningNotification(
  accountId: string,
  summary: TodaySummary,
): PushNotification | null {
  const parts = summaryParts(summary.cards);
  if (parts.length === 0) return null;
  const week = summary.money.thisWeek;
  const sales =
    week.sales === 0
      ? ''
      : ` This week: ${String(week.itemsSold)} sold for ${formatMoney(week.salesCents, summary.money.currency)}.`;
  return {
    accountId,
    category: TODAY_SUMMARY_CATEGORY,
    title: 'Your day on Listora',
    body: `${capitalize(joinList(parts))}.${sales}`,
    urgency: 'normal',
    threadId: 'today',
    data: { screen: 'today' },
  };
}

/** What needs the seller, most pressing first, in a few words each. */
function summaryParts(cards: readonly TodayCard[]): string[] {
  const of = <K extends TodayCard['kind']>(kind: K): Extract<TodayCard, { kind: K }>[] =>
    cards.filter((card): card is Extract<TodayCard, { kind: K }> => card.kind === kind);
  const parts: string[] = [];

  const delist = of('delist');
  const stuck = delist.filter((card) => card.urgency === 'urgent').length;
  if (stuck > 0) parts.push(`finish delisting ${plural(stuck, 'sold item')}`);
  if (delist.length > stuck) parts.push(`${plural(delist.length - stuck, 'delist')} in progress`);

  const ship = of('ship');
  if (ship.length > 0) {
    const soon = ship.filter((card) => card.urgency === 'urgent').length;
    parts.push(
      `ship ${plural(ship.length, 'item')}${soon > 0 ? ` (${String(soon)} due soon)` : ''}`,
    );
  }

  const reconnect = of('reconnect');
  if (reconnect.length > 0) {
    const names = [...new Set(reconnect.map((card) => MARKETPLACE_NAMES[card.marketplace]))];
    parts.push(`reconnect ${joinList(names)}`);
  }

  const drafts = of('review_drafts')[0];
  if (drafts !== undefined) parts.push(`review ${plural(drafts.count, 'draft')}`);

  return parts;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** "a", "a and b", "a, b, and c". */
function joinList(parts: readonly string[]): string {
  if (parts.length <= 2) return parts.join(' and ');
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1) ?? ''}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
