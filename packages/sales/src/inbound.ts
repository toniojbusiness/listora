/**
 * Inbound sale and marketplace signals (`inbound_event`): webhooks, poll results, emails, and
 * manual entries. Each one is stored once per account, source, marketplace, and provider event
 * id, so a delivery eBay repeats (it resends until acknowledged) or a poll that sees the same
 * order again is recognized as a duplicate and changes nothing. An event is finished exactly
 * once, with `processed`, `ignored`, or `failed` and a reason.
 */
import {
  jsonb,
  type DbExecutor,
  type InboundEventResult,
  type InboundEventSource,
} from '@listora/db';
import type { JsonValue, Marketplace } from '@listora/db';

export interface NewInboundEvent {
  accountId: string;
  source: InboundEventSource;
  marketplace: Marketplace;
  /** The marketplace's id of the event (eBay `notificationId`), or `order:<id>` for a poll. */
  providerEventId: string;
  /** The verified signature result; `null` for sources without one (polls, manual entries). */
  signatureOk: boolean | null;
  payload: JsonValue;
  /** The marketplace user the event is about (eBay userId), so deleting their data finds it. */
  externalUserId: string | null;
}

export type RecordedInboundEvent =
  | { duplicate: false; id: string }
  /** The same event was stored before; nothing changed. */
  | { duplicate: true; id: string };

/** Stores an event unless it was stored before. */
export async function recordInboundEvent(
  executor: DbExecutor,
  event: NewInboundEvent,
): Promise<RecordedInboundEvent> {
  const inserted = await executor
    .insertInto('inbound_event')
    .values({
      account_id: event.accountId,
      source: event.source,
      marketplace: event.marketplace,
      provider_event_id: event.providerEventId,
      signature_ok: event.signatureOk,
      payload: jsonb(event.payload),
      external_user_id: event.externalUserId,
    })
    .onConflict((conflict) => conflict.constraint('inbound_event_provider_event_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted !== undefined) return { duplicate: false, id: inserted.id };
  const existing = await executor
    .selectFrom('inbound_event')
    .select('id')
    .where('account_id', '=', event.accountId)
    .where('source', '=', event.source)
    .where('marketplace', '=', event.marketplace)
    .where('provider_event_id', '=', event.providerEventId)
    .executeTakeFirstOrThrow();
  return { duplicate: true, id: existing.id };
}

/** Records how an event ended; an event that is already finished keeps its first result. */
export async function finishInboundEvent(
  executor: DbExecutor,
  accountId: string,
  eventId: string,
  result: InboundEventResult,
  errorMessage: string | null = null,
): Promise<void> {
  if (result === 'failed' && errorMessage === null) {
    throw new Error('a failed inbound event needs a reason');
  }
  await executor
    .updateTable('inbound_event')
    .set({ result, processed_at: new Date(), error_message: errorMessage })
    .where('account_id', '=', accountId)
    .where('id', '=', eventId)
    .where('processed_at', 'is', null)
    .execute();
}
