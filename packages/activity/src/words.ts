/**
 * The seller's words for each kind of record on a timeline (docs/features/activity.md). Pure, so
 * every phrase is tested without a database. The API's operation history uses
 * `operationEventMessage` too, so a step reads the same everywhere.
 */
import type {
  AutomationRunHost,
  AutomationRunOutcome,
  AutomationRunPurpose,
  InboundEventResult,
  InboundEventSource,
  JsonObject,
  Marketplace,
  OperationKind,
  OperationOrigin,
  OperationStatus,
  SaleCheckOutcome,
  SaleCheckRunKind,
  SaleDetectionSource,
  UserTaskKind,
} from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { assertNever } from '@listora/shared';

import type { ActivityOutcome, ActivitySource } from './entry.ts';

/** The error message an operation event's detail recorded (`transitionOperation` stores it). */
export function operationEventError(detail: JsonObject): string | null {
  const error = detail['error'];
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null;
  const message = error['message'];
  return typeof message === 'string' ? message : null;
}

/** What happened at one step of an operation, in the seller's words. */
export function operationEventMessage(
  event: {
    from_status: OperationStatus | null;
    to_status: OperationStatus;
    attempt: number;
    detail: JsonObject;
  },
  marketplace: Marketplace,
): string {
  const name = MARKETPLACE_NAMES[marketplace];
  const error = operationEventError(event.detail);
  switch (event.to_status) {
    case 'queued':
      return event.from_status === 'failed' ? 'You asked Listora to try again.' : 'Queued.';
    case 'running':
      return `Working on it with ${name}.`;
    case 'retrying':
      return `${error ?? `${name} didn't take the change.`} Listora will try again.`;
    case 'verifying':
      return error ?? `Checking the listing on ${name}.`;
    case 'needs_user_action':
      return `Waiting for you to finish it on ${name}.`;
    case 'succeeded':
      return event.detail['evidence'] === 'user_confirmation'
        ? 'You confirmed it.'
        : `${name} confirmed it.`;
    case 'failed':
      return error ?? 'It failed.';
    case 'canceled':
      return 'Canceled.';
    default:
      return assertNever(event.to_status, 'operation status');
  }
}

/** How a step of an operation went. */
export function operationEventOutcome(status: OperationStatus): ActivityOutcome {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'needs_user_action':
      return 'waiting';
    case 'queued':
    case 'running':
    case 'retrying':
    case 'verifying':
      return 'in_progress';
    case 'canceled':
      return 'info';
    default:
      return assertNever(status, 'operation status');
  }
}

/** Who moved an operation into a status: the seller for a confirmation or a Retry. */
export function operationEventSource(event: {
  from_status: OperationStatus | null;
  to_status: OperationStatus;
  detail: JsonObject;
}): ActivitySource {
  if (event.to_status === 'succeeded' && event.detail['evidence'] === 'user_confirmation') {
    return 'you';
  }
  if (event.to_status === 'queued' && event.from_status === 'failed') return 'you';
  return 'listora';
}

/** What an operation does, as a timeline names it ("Delist on Mercari"). */
export function operationTitle(
  kind: OperationKind,
  origin: OperationOrigin,
  marketplace: Marketplace,
): string {
  const name = MARKETPLACE_NAMES[marketplace];
  switch (kind) {
    case 'create':
      return `Publish on ${name}`;
    case 'revise':
      return `Update the ${name} listing`;
    case 'price':
      return `Change the price on ${name}`;
    case 'end':
      return origin === 'auto_delist' ? `Delist on ${name} after the sale` : `End on ${name}`;
    case 'relist':
      return `Relist on ${name}`;
    case 'mark_sold':
      return origin === 'auto_delist'
        ? `Mark sold on ${name} after the sale`
        : `Mark sold on ${name}`;
    case 'verify':
      return `Check the ${name} listing`;
    case 'refresh':
      return `Refresh on ${name}`;
    default:
      return assertNever(kind, 'operation kind');
  }
}

/** Where a browser session ran. */
export function hostSource(host: AutomationRunHost): ActivitySource {
  return host === 'phone' ? 'iphone' : 'cloud_browser';
}

/**
 * What a browser session did, by the script it ran (`WRITE_SCRIPTS` and the reads in
 * `@listora/automation`), so a timeline never shows a script's name.
 */
const SCRIPT_WORDS: Readonly<Record<string, string>> = {
  create: 'posted the listing',
  revise: 'updated the listing',
  price: 'changed the price',
  end: 'ended the listing',
  relist: 'relisted it',
  markSold: 'marked it sold',
  read: 'read the listing',
  health: 'checked your sign-in',
  orders: 'read your sales',
  listings: 'read your listings',
};

/** A browser session, as a timeline names it. */
export function browserSessionTitle(run: {
  host: AutomationRunHost;
  purpose: AutomationRunPurpose;
  script: string;
  marketplace: Marketplace;
}): string {
  const where = run.host === 'phone' ? 'Your iPhone' : "Listora's cloud browser";
  const name = MARKETPLACE_NAMES[run.marketplace];
  switch (run.purpose) {
    case 'operation':
      return `${where} ${SCRIPT_WORDS[run.script] ?? 'worked on the listing'} on ${name}`;
    case 'sale_check':
      return `${where} read your ${name} sales`;
    case 'health':
      return `${where} checked your ${name} sign-in`;
    case 'import':
      return `${where} read your ${name} listings for an import`;
    case 'label_read':
      return `${where} read your ${name} shipping labels`;
    case 'offer_check':
      return `${where} read your ${name} offers`;
    case 'offer_response':
      return `${where} answered an offer on ${name}`;
    default:
      return assertNever(run.purpose, 'automation run purpose');
  }
}

/** How a browser session ended, in words: its steps and time, or where and why it stopped. */
export function browserSessionDetail(run: {
  outcome: AutomationRunOutcome | null;
  failed_step: string | null;
  error_code: string | null;
  steps: number;
  durationMs: number | null;
}): string {
  const took = run.durationMs === null ? '' : ` in ${duration(run.durationMs)}`;
  const steps = run.steps === 1 ? '1 step' : `${String(run.steps)} steps`;
  switch (run.outcome) {
    case null:
      return 'Running now.';
    case 'succeeded':
      return `Done${took} (${steps}).`;
    case 'canceled':
      return `Stopped before it finished${run.failed_step === null ? '' : ` (at “${run.failed_step}”)`}.`;
    case 'challenge':
      return `Stopped at “${run.failed_step ?? 'start'}”: the marketplace asked to check it's you.`;
    case 'timeout':
      return `Stopped at “${run.failed_step ?? 'start'}”: the step took too long.`;
    case 'failed':
      return `Stopped at “${run.failed_step ?? 'start'}”: ${stopReason(run.error_code)}.`;
    default:
      return assertNever(run.outcome, 'automation run outcome');
  }
}

function stopReason(code: string | null): string {
  switch (code) {
    case 'element_missing':
      return "the page wasn't what Listora knows (it may have changed)";
    case 'rate_limited':
      return 'the marketplace asked Listora to slow down';
    case 'server_error':
      return 'the marketplace had an error';
    case 'unreachable':
      return "Listora couldn't reach the marketplace";
    case 'browser_unavailable':
      return "Listora's browser didn't start";
    case 'stopped_for_check':
      return 'a check waits for you on your iPhone';
    case 'session_missing':
      return 'there was no sign-in to use';
    case null:
      return 'it failed';
    default:
      return code.replaceAll('_', ' ');
  }
}

export function browserSessionOutcome(outcome: AutomationRunOutcome | null): ActivityOutcome {
  if (outcome === null) return 'in_progress';
  return outcome === 'succeeded' ? 'succeeded' : outcome === 'canceled' ? 'info' : 'failed';
}

/** A sale check, or a read of the sold history, as a timeline names it. */
export function saleCheckTitle(check: {
  kind: SaleCheckRunKind;
  outcome: SaleCheckOutcome | null;
  marketplace: Marketplace;
}): string {
  const name = MARKETPLACE_NAMES[check.marketplace];
  if (check.kind === 'history') {
    return check.outcome === null || check.outcome === 'succeeded'
      ? `Read your ${name} sold history`
      : `Couldn't read your ${name} sold history`;
  }
  switch (check.outcome) {
    case null:
      return `Checking ${name} for sales`;
    case 'succeeded':
      return `Checked ${name} for sales`;
    case 'failed':
    case 'challenge':
      return `Couldn't check ${name} for sales`;
    default:
      return assertNever(check.outcome, 'sale check outcome');
  }
}

/** What a sale check read, or why it failed. */
export function saleCheckDetail(check: {
  kind: SaleCheckRunKind;
  outcome: SaleCheckOutcome | null;
  host: AutomationRunHost;
  orders_seen: number | null;
  new_orders: number | null;
  error_message: string | null;
}): string {
  const where = check.host === 'phone' ? 'on your iPhone' : "in Listora's cloud browser";
  if (check.outcome === null) return `Running ${where} now.`;
  if (check.outcome !== 'succeeded') return check.error_message ?? 'It failed.';
  const seen = check.orders_seen ?? 0;
  const orders = seen === 1 ? '1 sold order' : `${String(seen)} sold orders`;
  if (check.kind === 'history') return `Saw ${orders} ${where}. Nothing was changed.`;
  const added = check.new_orders ?? 0;
  if (seen === 0) return `No sold orders to look at, ${where}.`;
  return added === 0
    ? `Saw ${orders} ${where}, none new.`
    : `Saw ${orders} ${where}, ${String(added)} new.`;
}

/** An order a marketplace reported or a check found, as a timeline names it. */
export function orderTitle(
  source: InboundEventSource,
  marketplace: Marketplace,
  orderId: string | null,
): string {
  const name = MARKETPLACE_NAMES[marketplace];
  const order = orderId === null ? `A ${name} order` : `${name} order ${orderId}`;
  switch (source) {
    case 'poll':
      return `${order} seen by a sale check`;
    case 'ebay_webhook':
    case 'depop_webhook':
      return `${order} reported by ${name}`;
    case 'email':
      return `${order} found in a forwarded sale email`;
    case 'manual':
      return `${order} entered by you`;
    default:
      return assertNever(source, 'inbound event source');
  }
}

export function orderSource(source: InboundEventSource): ActivitySource {
  switch (source) {
    case 'ebay_webhook':
    case 'depop_webhook':
      return 'marketplace';
    case 'manual':
      return 'you';
    case 'poll':
    case 'email':
      return 'listora';
    default:
      return assertNever(source, 'inbound event source');
  }
}

/** What Listora did with an order. */
export function orderDetail(result: InboundEventResult | null, error: string | null): string {
  switch (result) {
    case null:
      return 'Waiting to be recorded.';
    case 'processed':
      return 'Recorded as a sale.';
    case 'ignored':
      return 'Nothing to do: the sale was recorded already, or the order showed nothing to record.';
    case 'failed':
      return error ?? "Listora couldn't read it.";
    default:
      return assertNever(result, 'inbound event result');
  }
}

/** An order a check stored again for its sold items' photos (`purpose: 'photos'`). */
export function orderPhotosDetail(result: InboundEventResult | null, error: string | null): string {
  switch (result) {
    case null:
      return "Waiting to add the sold listing's photos to its sold item.";
    case 'processed':
      return "Its sold item got the sold listing's photos.";
    case 'ignored':
      return 'No photos added: the item has photos already, or none could be fetched.';
    case 'failed':
      return error ?? "Listora couldn't read it.";
    default:
      return assertNever(result, 'inbound event result');
  }
}

/** How Listora learned of a sale. */
export function saleDetectionWords(source: SaleDetectionSource, marketplace: Marketplace): string {
  const name = MARKETPLACE_NAMES[marketplace];
  switch (source) {
    case 'poll':
      return `Listora found it on ${name}.`;
    case 'webhook':
      return `${name} told Listora about it.`;
    case 'email':
      return 'Found in a forwarded sale email.';
    case 'manual':
      return 'You marked it sold.';
    case 'history':
      return `Found in your ${name} sales history.`;
    default:
      return assertNever(source, 'sale detection source');
  }
}

/** A task for the seller, as a timeline names it. */
export function taskTitle(kind: UserTaskKind, marketplace: Marketplace | null): string {
  const on = marketplace === null ? '' : ` on ${MARKETPLACE_NAMES[marketplace]}`;
  switch (kind) {
    case 'list_manually':
      return `Waiting for you: list it${on}`;
    case 'delist_manually':
      return `Waiting for you: delist it${on}`;
    case 'edit_manually':
      return `Waiting for you: change the listing${on}`;
    case 'confirm_sale':
      return 'Waiting for you: confirm the sale';
    case 'reconnect':
      return `Waiting for you: sign in again${on}`;
    case 'review_match':
      return 'Waiting for you: check which item sold';
    case 'resolve_double_sale':
      return 'Waiting for you: it sold twice';
    case 'answer_offer':
      return `Waiting for you: answer an offer${on}`;
    default:
      return assertNever(kind, 'user task kind');
  }
}

/** An item change, as a timeline names it (`audit_log.action`). */
export function itemChangeTitle(action: string, changes: JsonObject): string {
  const marketplace = changes['marketplace'];
  const on =
    typeof marketplace === 'string' && marketplace in MARKETPLACE_NAMES
      ? ` on ${MARKETPLACE_NAMES[marketplace as Marketplace]}`
      : '';
  switch (action) {
    case 'item.created':
      return 'Item created';
    case 'item.updated':
      return 'Item details changed';
    case 'item.analysis_applied':
      return 'AI suggestions applied';
    case 'item.deleted':
      return 'Item deleted';
    case 'item.sold':
      return `Sold${on}`;
    case 'item.delisted':
      return 'Delisted everywhere else';
    case 'item.double_sale':
      return `Sold twice${on}`;
    case 'item.shipped':
      return 'Marked shipped';
    case 'listing.created':
      return `Listing drafted${on}`;
    case 'listing.draft_updated':
      return `Draft listing changed${on}`;
    case 'listing.linked':
      return `Linked to an existing listing${on}`;
    case 'photo.added':
      return 'Photo added';
    case 'photo.removed':
      return 'Photo removed';
    case 'photo.reordered':
      return 'Photos reordered';
    case 'photo.role_changed':
      return 'Photo changed';
    case 'task.completed':
      return `You marked a task done${on}`;
    case 'task.dismissed':
      return `You dismissed a task${on}`;
    case 'sale.confirmed':
      return 'Sale confirmed';
    default: {
      const words = action.replaceAll(/[._]/g, ' ').trim();
      return words === '' ? 'Item changed' : `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`;
    }
  }
}

/** Integer cents as dollars, `$25.00`. */
export function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const whole = Math.abs(cents);
  return `${sign}$${String(Math.floor(whole / 100))}.${String(whole % 100).padStart(2, '0')}`;
}

/** A duration as people say it: `850 ms`, `12.3 s`, `2 min 5 s`. */
export function duration(ms: number): string {
  if (ms < 1_000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1_000);
  return `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`;
}
