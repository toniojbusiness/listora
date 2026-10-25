/**
 * The push notifications auto-delist sends (docs/features/auto-delist.md). Each names the item
 * and says what is left and who does it: Listora (API listings) or the seller (assisted ones).
 * They are time-sensitive, grouped per item on the device, and open the item when tapped.
 */
import type { Marketplace } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import type { PushNotification } from '@listora/push';

import { listNames, type DelistResult } from './results.ts';

const LABEL_MAX_LENGTH = 60;

/** The item as the seller knows it: its title, or its SKU when it has none. */
export function itemLabel(item: { title: string | null; sku: string }): string {
  const title = item.title?.trim() ?? '';
  if (title === '') return item.sku;
  return title.length <= LABEL_MAX_LENGTH ? title : `${title.slice(0, LABEL_MAX_LENGTH - 3)}...`;
}

interface PushContext {
  accountId: string;
  itemId: string;
  saleId: string;
  label: string;
  soldOn: Marketplace;
}

function push(
  context: PushContext,
  category: string,
  title: string,
  body: string,
  data: Record<string, string>,
): PushNotification {
  return {
    accountId: context.accountId,
    category,
    title,
    body,
    urgency: 'time_sensitive',
    threadId: `item:${context.itemId}`,
    data: { itemId: context.itemId, saleId: context.saleId, ...data },
  };
}

/** Right after the sale: what Listora delists itself and what the seller has to. */
export function soldNotification(
  context: PushContext & { delistRunId: string },
  targets: { listora: readonly Marketplace[]; seller: readonly Marketplace[] },
): PushNotification {
  const parts = [`${context.label} sold on ${MARKETPLACE_NAMES[context.soldOn]}.`];
  if (targets.listora.length > 0) {
    parts.push(`Listora is delisting it on ${listNames(targets.listora)}.`);
  }
  if (targets.seller.length > 0) parts.push(`Delist it on ${listNames(targets.seller)} now.`);
  return push(
    context,
    'item_sold',
    `Sold on ${MARKETPLACE_NAMES[context.soldOn]}`,
    parts.join(' '),
    { delistRunId: context.delistRunId },
  );
}

/** What is still open, by who has to act. */
function openParts(results: readonly DelistResult[]): string[] {
  const where = (states: readonly DelistResult['state'][]) =>
    results.filter((result) => states.includes(result.state)).map((result) => result.marketplace);
  const parts: string[] = [];
  const action = where(['needs_user_action']);
  if (action.length > 0) parts.push(`Delist it on ${listNames(action)} now.`);
  const failed = where(['failed']);
  if (failed.length > 0) {
    parts.push(`Delisting failed on ${listNames(failed)}; open Listora to retry.`);
  }
  const pending = where(['pending', 'verifying']);
  if (pending.length > 0) parts.push(`Listora is still delisting it on ${listNames(pending)}.`);
  return parts;
}

/** Ten minutes after the sale, anything not delisted or confirmed yet. */
export function reminderNotification(
  context: PushContext & { delistRunId: string },
  open: readonly DelistResult[],
): PushNotification {
  return push(
    context,
    'delist_reminder',
    `Still listed: ${context.label}`,
    [`It sold on ${MARKETPLACE_NAMES[context.soldOn]} 10 minutes ago.`, ...openParts(open)].join(
      ' ',
    ),
    { delistRunId: context.delistRunId },
  );
}

/** Thirty minutes after the sale: the same, now as a double-sale risk. */
export function escalationNotification(
  context: PushContext & { delistRunId: string },
  open: readonly DelistResult[],
): PushNotification {
  return push(
    context,
    'delist_escalation',
    `Double-sale risk: ${context.label}`,
    [
      `It sold on ${MARKETPLACE_NAMES[context.soldOn]} 30 minutes ago and is still listed on ${listNames(open.map((result) => result.marketplace))}.`,
      ...openParts(open),
    ].join(' '),
    { delistRunId: context.delistRunId },
  );
}

/** An item that had sold sold again: one of the orders must be canceled. */
export function doubleSaleNotification(
  context: PushContext & { taskId: string; earlierSoldOn: Marketplace },
): PushNotification {
  const again =
    context.earlierSoldOn === context.soldOn
      ? `again on ${MARKETPLACE_NAMES[context.soldOn]}`
      : `on ${MARKETPLACE_NAMES[context.soldOn]} after it sold on ${MARKETPLACE_NAMES[context.earlierSoldOn]}`;
  return push(
    context,
    'double_sale',
    `Double sale: ${context.label}`,
    `It sold ${again}. Cancel one of the orders; Listora has the steps.`,
    { taskId: context.taskId },
  );
}
