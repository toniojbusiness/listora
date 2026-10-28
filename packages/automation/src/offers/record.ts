/**
 * Recording a read of a connection's offers (docs/features/offers.md). The read only reads; what
 * it showed becomes Listora's view of the offers:
 *
 * - an offer that waits on the seller is `pending`, with the listing and item Listora has for it,
 *   and has one open `answer_offer` task in the seller's inbox;
 * - an offer Listora had as pending that the read no longer shows waiting on the seller is
 *   `closed` (it expired, the buyer withdrew it or bought the listing, or the seller answered it
 *   in the marketplace's app), and its task closes, unless an answer from Listora is under way:
 *   that answer's own read-back decides it;
 * - an offer the read shows waiting on the buyer that Listora never had is not the seller's to
 *   answer, and is not kept.
 *
 * A read that failed changes no offer: the inbox keeps what the last read showed, and the
 * connection's `offer_check` says when that was and why the newest read failed.
 */
import { sql } from 'kysely';

import {
  inTransaction,
  jsonb,
  type DbExecutor,
  type JsonObject,
  type Marketplace,
} from '@listora/db';
import { MARKETPLACE_NAMES, type RemoteOffer } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { AutomationReadError } from '../adapter/automation-adapter.ts';
import type { OfferCheckTarget } from './schedule.ts';

const OPEN_RESPONSE = ['queued', 'running', 'verifying'] as const;

/** Marks the read as started (`last_started_at`). */
export async function startOfferCheck(db: DbExecutor, target: OfferCheckTarget): Promise<void> {
  await db
    .insertInto('offer_check')
    .values({
      account_id: target.accountId,
      connection_id: target.connectionId,
      marketplace: target.marketplace,
      last_started_at: sql<Date>`now()`,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['account_id', 'connection_id'])
        .doUpdateSet({ last_started_at: sql<Date>`now()` }),
    )
    .execute();
}

/** Keeps what the read showed: the pending offers and their tasks, and the ones that closed. */
export async function recordOffers(
  db: DbExecutor,
  target: OfferCheckTarget,
  offers: readonly RemoteOffer[],
  logger: Logger,
): Promise<{ pending: number; closed: number }> {
  return inTransaction(db, async (trx) => {
    const seen = new Set<string>();
    let pending = 0;
    for (const offer of offers) {
      if (seen.has(offer.externalOfferId)) continue;
      seen.add(offer.externalOfferId);
      if (offer.turn === 'seller') {
        await keepPendingOffer(trx, target, offer);
        pending += 1;
      } else {
        // The seller answered it elsewhere (in the marketplace's app): no longer theirs to answer.
        await closeOffers(trx, target, [offer.externalOfferId], 'countered', offer.amountCents);
      }
    }
    const gone = await trx
      .selectFrom('marketplace_offer as offer')
      .select('offer.external_offer_id')
      .where('offer.account_id', '=', target.accountId)
      .where('offer.connection_id', '=', target.connectionId)
      .where('offer.status', '=', 'pending')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('offer_response as response')
              .select('response.id')
              .whereRef('response.account_id', '=', 'offer.account_id')
              .whereRef('response.offer_id', '=', 'offer.id')
              .where('response.status', 'in', OPEN_RESPONSE),
          ),
        ),
      )
      .execute();
    const closing = gone.map((row) => row.external_offer_id).filter((id) => !seen.has(id));
    const closed = await closeOffers(trx, target, closing, 'closed', null);
    await trx
      .updateTable('offer_check')
      .set({
        last_finished_at: sql<Date>`now()`,
        last_succeeded_at: sql<Date>`now()`,
        last_outcome: 'succeeded',
        last_error_code: null,
        last_error_message: null,
        offers_seen: pending,
      })
      .where('account_id', '=', target.accountId)
      .where('connection_id', '=', target.connectionId)
      .execute();
    logger.info(
      {
        event: 'offers_read',
        marketplace: target.marketplace,
        connectionId: target.connectionId,
        pending,
        closed,
      },
      'offers read',
    );
    return { pending, closed };
  });
}

/** A read that failed: the offers stay as the last read showed them; the check says why. */
export async function recordOfferCheckFailure(
  db: DbExecutor,
  target: OfferCheckTarget,
  error: unknown,
  logger: Logger,
): Promise<void> {
  const code = error instanceof AutomationReadError ? error.code : 'read_failed';
  logger.warn(
    {
      event: 'offers_read_failed',
      marketplace: target.marketplace,
      connectionId: target.connectionId,
      code,
      step: error instanceof AutomationReadError ? error.step : null,
      err: error instanceof Error ? { name: error.name, message: error.message } : error,
    },
    'offers not read',
  );
  await db
    .updateTable('offer_check')
    .set({
      last_finished_at: sql<Date>`now()`,
      last_outcome: 'failed',
      last_error_code: code.slice(0, 100),
      last_error_message: offerReadErrorMessage(code, target.marketplace).slice(0, 500),
    })
    .where('account_id', '=', target.accountId)
    .where('connection_id', '=', target.connectionId)
    .execute();
}

/** The seller's words for why a read of their offers failed. */
export function offerReadErrorMessage(code: string, marketplace: Marketplace): string {
  const name = MARKETPLACE_NAMES[marketplace];
  switch (code) {
    case 'captcha':
    case 'bot_check':
    case 'login_challenge':
      return `${name} asked to check it's you, so Listora couldn't read your offers. Link ${name} again.`;
    case 'session_rejected':
    case 'no_session':
      return `${name} signed Listora out, so it couldn't read your offers. Link ${name} again.`;
    case 'stopped_for_check':
      return `${name} wants you to complete a check in Listora on your iPhone before it reads your offers.`;
    case 'element_missing':
      return `${name}'s offers page has changed, so Listora couldn't read your offers there.`;
    case 'rate_limited':
    case 'automation_paced':
    case 'automation_busy':
      return `Listora will read your ${name} offers again shortly.`;
    default:
      return `Listora couldn't read your ${name} offers just now.`;
  }
}

async function keepPendingOffer(
  trx: DbExecutor,
  target: OfferCheckTarget,
  offer: RemoteOffer,
): Promise<void> {
  const listing =
    offer.externalListingId === null
      ? undefined
      : await trx
          .selectFrom('marketplace_listing')
          .select(['id', 'item_id', 'price_cents'])
          .where('account_id', '=', target.accountId)
          .where('marketplace', '=', target.marketplace)
          .where('external_listing_id', '=', offer.externalListingId)
          .executeTakeFirst();
  const details = jsonb({
    listingCount: offer.listingCount,
    shippingCents: offer.shippingCents,
  });
  const values = {
    external_listing_id: offer.externalListingId?.slice(0, 255) ?? null,
    listing_id: listing?.id ?? null,
    item_id: listing?.item_id ?? null,
    listing_title: offer.listingTitle?.slice(0, 200) ?? null,
    amount_cents: offer.amountCents,
    // Depop's offers name no price: the listing's own, as Listora last confirmed it.
    list_price_cents: offer.listPriceCents ?? listing?.price_cents ?? null,
    buyer_name: offer.buyerName?.slice(0, 100) ?? null,
    offer_url: offer.url?.slice(0, 2000) ?? null,
    made_at: offer.madeAt,
    expires_at: offer.expiresAt,
  };
  const row = await trx
    .insertInto('marketplace_offer')
    .values({
      account_id: target.accountId,
      connection_id: target.connectionId,
      marketplace: target.marketplace,
      external_offer_id: offer.externalOfferId.slice(0, 255),
      details,
      ...values,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['account_id', 'connection_id', 'external_offer_id'])
        .doUpdateSet({
          ...values,
          details,
          // A countered or answered offer back on the seller's turn (the buyer countered) waits
          // on them again.
          status: 'pending',
          closed_at: null,
          last_seen_at: sql<Date>`now()`,
        })
        // An accepted or declined offer is final, and one the seller countered waits on the buyer
        // until the buyer answers with another price: a read that lags behind shows neither.
        .where((eb) =>
          eb.or([
            eb('marketplace_offer.status', 'in', ['pending', 'closed']),
            eb.and([
              eb('marketplace_offer.status', '=', 'countered'),
              eb('marketplace_offer.amount_cents', '<>', eb.ref('excluded.amount_cents')),
            ]),
          ]),
        ),
    )
    .returning(['id', 'item_id', 'listing_id', 'offer_url'])
    .executeTakeFirst();
  if (row === undefined) return;
  const open = await trx
    .updateTable('user_task')
    .set({ item_id: row.item_id, listing_id: row.listing_id, deep_link: row.offer_url })
    .where('account_id', '=', target.accountId)
    .where('offer_id', '=', row.id)
    .where('status', '=', 'open')
    .returning('id')
    .executeTakeFirst();
  if (open !== undefined) return;
  // The seller dismissed this offer's task: it stays dismissed until the offer changes.
  const dismissed = await trx
    .selectFrom('user_task')
    .select('id')
    .where('account_id', '=', target.accountId)
    .where('offer_id', '=', row.id)
    .where('status', '=', 'dismissed')
    .where(sql<boolean>`(payload ->> 'amountCents')::bigint = ${offer.amountCents}`)
    .executeTakeFirst();
  if (dismissed !== undefined) return;
  await trx
    .insertInto('user_task')
    .values({
      account_id: target.accountId,
      kind: 'answer_offer',
      offer_id: row.id,
      item_id: row.item_id,
      listing_id: row.listing_id,
      deep_link: row.offer_url,
      payload: jsonb({ marketplace: target.marketplace, amountCents: offer.amountCents }),
    })
    .execute();
}

/** Closes offers no longer waiting on the seller, and their open tasks. */
async function closeOffers(
  trx: DbExecutor,
  target: OfferCheckTarget,
  externalOfferIds: readonly string[],
  status: 'closed' | 'countered',
  amountCents: number | null,
): Promise<number> {
  if (externalOfferIds.length === 0) return 0;
  const closed = await trx
    .updateTable('marketplace_offer')
    .set({
      status,
      closed_at: sql<Date>`now()`,
      ...(amountCents === null ? {} : { amount_cents: amountCents }),
      ...(status === 'countered' ? { last_seen_at: sql<Date>`now()` } : {}),
    })
    .where('account_id', '=', target.accountId)
    .where('connection_id', '=', target.connectionId)
    .where('external_offer_id', 'in', externalOfferIds)
    .where('status', '=', 'pending')
    .returning('id')
    .execute();
  await closeOfferTasks(
    trx,
    target.accountId,
    closed.map((row) => row.id),
    'marketplace',
  );
  return closed.length;
}

/**
 * Closes the offers' open tasks: `marketplace` when the marketplace no longer shows the offer
 * waiting on the seller, `listora` when the seller's answer from Listora was read back.
 */
export async function closeOfferTasks(
  trx: DbExecutor,
  accountId: string,
  offerIds: readonly string[],
  closedBy: 'marketplace' | 'listora',
): Promise<void> {
  if (offerIds.length === 0) return;
  await trx
    .updateTable('user_task')
    .set({
      status: 'done',
      completed_at: sql<Date>`now()`,
      payload: sql<JsonObject>`payload || ${JSON.stringify({ closedBy })}::jsonb`,
    })
    .where('account_id', '=', accountId)
    .where('offer_id', 'in', offerIds)
    .where('status', '=', 'open')
    .execute();
}
