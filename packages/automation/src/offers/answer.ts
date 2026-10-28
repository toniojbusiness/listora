/**
 * The seller's answer to an offer (docs/features/offers.md): accept, decline, or counter, asked
 * for only by the seller's confirmed tap (`requestOfferAnswer`), sent once by the phone, and done
 * only once a read of the offer afterwards shows it. The rules are the operation engine's
 * (docs/features/operations.md), for an offer instead of a listing:
 *
 * - A response is sent at most once: from the moment a send may have reached the marketplace
 *   (`sent`), it is only ever read back, never sent again. A send that surely changed nothing
 *   (Listora's pacing, a page that failed to load before the answer) is sent again later, at most
 *   `MAX_SENDS` times.
 * - It is `succeeded` only with a read of the offer that shows the answer (`answerShown`), as
 *   `success_evidence = 'read_back'`. A read that doesn't show it yet is read again, a little
 *   later, up to `MAX_ATTEMPTS` steps in all; then it fails and asks the seller to check the
 *   offer on the marketplace, never claiming either way.
 * - The marketplace refusing it, or showing the offer answered otherwise or gone, fails it with
 *   the marketplace's reason. A check automation must not pass fails it too: the seller answers
 *   in the marketplace's app (Open in Poshmark).
 * - An accepted offer asks for a sale check at once, so the sale is recorded and delisted
 *   everywhere else by the normal sale flow (docs/features/auto-delist.md) once the marketplace
 *   shows it sold: at once on Poshmark, when the buyer checks out on Mercari and Depop.
 */
import { sql } from 'kysely';

import {
  inTransaction,
  type DbExecutor,
  type Marketplace,
  type OfferAction,
  type OfferResponseStatus,
} from '@listora/db';
import {
  answerShown,
  isFeatureVerified,
  isOfferMarketplace,
  MARKETPLACE_NAMES,
  OFFER_RULES,
  type ConnectionRef,
  type MarketplaceAdapter,
  type OfferAnswerOutcome,
  type OfferAnswerRequest,
  type RemoteOfferState,
} from '@listora/marketplaces';
import { estimateFeesCents, feeTableFor } from '@listora/pricing';
import type { Logger } from '@listora/shared';

import { AutomationReadError } from '../adapter/automation-adapter.ts';
import { requestSaleCheck } from '../sale-checks/schedule.ts';
import { closeOfferTasks } from './record.ts';
import { queueOfferCheck, queueOfferResponse } from './schedule.ts';

/** Sends that surely changed nothing, at most; then the answer fails with a Retry. */
export const MAX_SENDS = 3;
/** Steps one answer takes at most (sends and reads); then it fails, asking the seller to check. */
export const MAX_ATTEMPTS = 6;
/** How long a send that changed nothing waits before it is sent again. */
const RESEND_DELAY_MS = 60_000;
/** How long a read that doesn't show the answer yet waits before the next read. */
const READ_AGAIN_DELAY_MS = 30_000;

const OPEN: readonly OfferResponseStatus[] = ['queued', 'running', 'verifying'];

/** Why Listora won't send an answer (the API maps the code to its status). */
export class OfferAnswerRefusedError extends Error {
  readonly code: 'not_found' | 'offer_closed' | 'answer_in_progress' | 'unavailable' | 'invalid';
  constructor(code: OfferAnswerRefusedError['code'], message: string) {
    super(message);
    this.name = 'OfferAnswerRefusedError';
    this.code = code;
  }
}

/** What the seller gets for a price on the marketplace, after its fees (an estimate). */
export interface OfferQuote {
  priceCents: number;
  feesCents: number;
  netCents: number;
}

/** The marketplace's fee estimate at `priceCents` (the fee tables, @listora/pricing). */
export function offerQuote(marketplace: Marketplace, priceCents: number, at: Date): OfferQuote {
  if (!isOfferMarketplace(marketplace)) {
    throw new Error(`Listora doesn't answer offers on ${marketplace}`);
  }
  const feesCents = Math.min(
    priceCents,
    estimateFeesCents(feeTableFor(marketplace, at), priceCents),
  );
  return { priceCents, feesCents, netCents: priceCents - feesCents };
}

/**
 * Which answers the offer takes on its marketplace: none on a read-only connection, and none
 * where answers have not passed live yet (docs/features/verified-features.md), so the app
 * shows no Accept, Decline, or Counter there and the seller answers in the marketplace's app.
 */
export function offerActions(marketplace: Marketplace, readOnly = false): OfferAction[] {
  if (!isOfferMarketplace(marketplace) || readOnly) return [];
  if (!isFeatureVerified(marketplace, 'offer_answers')) return [];
  return OFFER_RULES[marketplace].counter
    ? ['accept', 'decline', 'counter']
    : ['accept', 'decline'];
}

export interface OfferAnswerInput {
  accountId: string;
  offerId: string;
  action: OfferAction;
  /** The seller's price for a counter, in cents. */
  counterCents: number | null;
  /** The offer's amount the seller confirmed: an offer that moved since is refused. */
  offerAmountCents: number;
  idempotencyKey: string;
  now: Date;
}

/**
 * Records the seller's answer and hands it to their phone. The same key returns the same
 * answer. Refused (`OfferAnswerRefusedError`) when the offer no longer waits on the seller, an
 * answer is already under way, the amount moved, the counter is out of range, or the
 * connection can't run it.
 */
export async function requestOfferAnswer(
  executor: DbExecutor,
  input: OfferAnswerInput,
): Promise<{ responseId: string; created: boolean }> {
  return inTransaction(executor, async (trx) => {
    const offer = await trx
      .selectFrom('marketplace_offer as offer')
      .innerJoin('marketplace_connection as connection', (join) =>
        join
          .onRef('connection.account_id', '=', 'offer.account_id')
          .onRef('connection.id', '=', 'offer.connection_id'),
      )
      .select([
        'offer.id',
        'offer.connection_id',
        'offer.marketplace',
        'offer.status',
        'offer.amount_cents',
        'offer.list_price_cents',
        'offer.expires_at',
        'connection.mode',
        'connection.status as connectionStatus',
        'connection.runs_on',
        'connection.read_only',
      ])
      .where('offer.account_id', '=', input.accountId)
      .where('offer.id', '=', input.offerId)
      .forUpdate()
      .executeTakeFirst();
    if (offer === undefined) throw new OfferAnswerRefusedError('not_found', 'No such offer.');
    const same = await trx
      .selectFrom('offer_response')
      .select('id')
      .where('account_id', '=', input.accountId)
      .where('offer_id', '=', input.offerId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();
    if (same !== undefined) return { responseId: same.id, created: false };
    const name = MARKETPLACE_NAMES[offer.marketplace];
    const open = await trx
      .selectFrom('offer_response')
      .select('id')
      .where('account_id', '=', input.accountId)
      .where('offer_id', '=', input.offerId)
      .where('status', 'in', OPEN)
      .executeTakeFirst();
    if (open !== undefined) {
      throw new OfferAnswerRefusedError(
        'answer_in_progress',
        `Listora is already answering this offer on ${name}.`,
      );
    }
    if (
      offer.status !== 'pending' ||
      (offer.expires_at !== null && offer.expires_at <= input.now)
    ) {
      throw new OfferAnswerRefusedError(
        'offer_closed',
        `This offer no longer waits for you on ${name}.`,
      );
    }
    if (offer.amount_cents !== input.offerAmountCents) {
      throw new OfferAnswerRefusedError(
        'invalid',
        `The buyer changed this offer on ${name}. Look at the new amount before you answer.`,
      );
    }
    // Listora never changes a read-only account (docs/features/read-only.md), offers included.
    if (offer.read_only) {
      throw new OfferAnswerRefusedError(
        'unavailable',
        `Listora only reads this ${name} account, so it can't answer its offers. Answer this one in ${name}.`,
      );
    }
    if (offerActions(offer.marketplace).length === 0) {
      throw new OfferAnswerRefusedError('unavailable', `Answer this offer in ${name}.`);
    }
    if (!offerActions(offer.marketplace).includes(input.action)) {
      throw new OfferAnswerRefusedError('invalid', `${name} doesn't take that answer to offers.`);
    }
    let counterCents: number | null = null;
    if (input.action === 'counter') {
      counterCents = input.counterCents;
      if (counterCents === null || counterCents <= offer.amount_cents) {
        throw new OfferAnswerRefusedError(
          'invalid',
          'A counteroffer has to be more than the buyer offered.',
        );
      }
      if (offer.list_price_cents !== null && counterCents >= offer.list_price_cents) {
        throw new OfferAnswerRefusedError(
          'invalid',
          'A counteroffer has to be less than your listing price.',
        );
      }
    } else if (input.counterCents !== null) {
      throw new OfferAnswerRefusedError('invalid', 'Only a counteroffer has a price of its own.');
    }
    const usable =
      offer.mode === 'automation' &&
      (offer.connectionStatus === 'connected' || offer.connectionStatus === 'degraded');
    if (!usable || offer.runs_on !== 'phone') {
      throw new OfferAnswerRefusedError(
        'unavailable',
        usable
          ? `Listora answers ${name} offers from your iPhone. Answer this one in ${name}.`
          : `Link ${name} again in Listora to answer offers, or answer this one in ${name}.`,
      );
    }
    const price = input.action === 'counter' ? (counterCents ?? 0) : offer.amount_cents;
    const quote = offerQuote(offer.marketplace, price, input.now);
    const response = await trx
      .insertInto('offer_response')
      .values({
        account_id: input.accountId,
        offer_id: input.offerId,
        action: input.action,
        offer_amount_cents: offer.amount_cents,
        counter_cents: counterCents,
        net_cents: input.action === 'decline' ? 0 : quote.netCents,
        idempotency_key: input.idempotencyKey,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await queueOfferResponse(trx, {
      accountId: input.accountId,
      connectionId: offer.connection_id,
      marketplace: offer.marketplace,
      responseId: response.id,
    });
    return { responseId: response.id, created: true };
  });
}

/** An answer ready to run on the phone. */
export interface PreparedOfferAnswer {
  accountId: string;
  responseId: string;
  connectionId: string;
  marketplace: Marketplace;
  connection: ConnectionRef;
  request: OfferAnswerRequest;
  offerId: string;
  /** An earlier step may have sent it: only read back. */
  sent: boolean;
  attempts: number;
  /** Sends so far that surely changed nothing. */
}

/** The answer to run now, or `null` when it is over (answered, failed, or gone). */
export async function prepareOfferAnswer(
  db: DbExecutor,
  key: { accountId: string; responseId: string },
): Promise<PreparedOfferAnswer | null> {
  const found = await db
    .selectFrom('offer_response as response')
    .innerJoin('marketplace_offer as offer', (join) =>
      join
        .onRef('offer.account_id', '=', 'response.account_id')
        .onRef('offer.id', '=', 'response.offer_id'),
    )
    .innerJoin('marketplace_connection as connection', (join) =>
      join
        .onRef('connection.account_id', '=', 'offer.account_id')
        .onRef('connection.id', '=', 'offer.connection_id'),
    )
    .select([
      'response.id',
      'response.status',
      'response.action',
      'response.offer_amount_cents',
      'response.counter_cents',
      'response.sent',
      'response.attempts',
      'offer.id as offerId',
      'offer.external_offer_id',
      'offer.external_listing_id',
      'offer.offer_url',
      'offer.marketplace',
      'connection.id as connectionId',
      'connection.mode',
      'connection.status as connectionStatus',
    ])
    .where('response.account_id', '=', key.accountId)
    .where('response.id', '=', key.responseId)
    .executeTakeFirst();
  if (found === undefined || !OPEN.includes(found.status)) return null;
  return {
    accountId: key.accountId,
    responseId: found.id,
    connectionId: found.connectionId,
    marketplace: found.marketplace,
    connection: { id: found.connectionId, mode: found.mode, status: found.connectionStatus },
    offerId: found.offerId,
    sent: found.sent,
    attempts: found.attempts,
    request: {
      responseId: found.id,
      answer: found.action,
      expectedAmountCents: found.offer_amount_cents,
      counterCents: found.counter_cents,
      offer: {
        externalOfferId: found.external_offer_id,
        externalListingId: found.external_listing_id,
        url: found.offer_url,
      },
    },
  };
}

/**
 * Fails an answer that must not be sent (its connection is read-only), before anything is sent.
 */
export async function refuseOfferAnswer(
  db: DbExecutor,
  prepared: Pick<PreparedOfferAnswer, 'accountId' | 'responseId' | 'marketplace'>,
  reason: 'read_only' | 'unavailable' = 'read_only',
): Promise<void> {
  const name = MARKETPLACE_NAMES[prepared.marketplace];
  await db
    .updateTable('offer_response')
    .set({
      status: 'failed',
      error_code: reason,
      error_message:
        reason === 'read_only'
          ? `Listora only reads this ${name} account, so it can't answer its offers. Answer this one in ${name}.`
          : `Answer this offer in ${name}.`,
      retryable: false,
      finished_at: sql<Date>`now()`,
    })
    .where('account_id', '=', prepared.accountId)
    .where('id', '=', prepared.responseId)
    .where('status', 'in', OPEN)
    .where('sent', '=', false)
    .execute();
}

/** What one step of an answer did: its send (unless an earlier one may have sent it) and its read. */
export interface OfferAnswerStep {
  outcome: OfferAnswerOutcome | null;
  read: { state: RemoteOfferState } | { error: unknown } | null;
}

/**
 * Runs one step through the adapter: the send, unless an earlier step may have sent it, then a
 * read of the offer whenever the answer may have reached the marketplace.
 */
export async function runOfferAnswer(
  adapter: MarketplaceAdapter,
  prepared: PreparedOfferAnswer,
  signal: AbortSignal,
): Promise<OfferAnswerStep> {
  const ctx = { connection: prepared.connection, signal };
  let outcome: OfferAnswerOutcome | null = null;
  if (!prepared.sent) {
    outcome =
      adapter.answerOffer === undefined
        ? {
            type: 'needs_seller',
            code: 'unsupported',
            message: `Answer this offer in ${MARKETPLACE_NAMES[prepared.marketplace]}.`,
          }
        : await adapter.answerOffer(prepared.request, ctx);
    if (outcome.type !== 'sent' && outcome.type !== 'unknown') return { outcome, read: null };
  }
  if (adapter.readOffer === undefined) return { outcome, read: { error: new Error('no read') } };
  try {
    return { outcome, read: { state: await adapter.readOffer(prepared.request.offer, ctx) } };
  } catch (error) {
    return { outcome, read: { error } };
  }
}

/** Records what the step found: done only with a read-back that shows it. */
export async function recordOfferAnswer(
  db: DbExecutor,
  prepared: PreparedOfferAnswer,
  step: OfferAnswerStep,
  logger: Logger,
): Promise<OfferResponseStatus> {
  const name = MARKETPLACE_NAMES[prepared.marketplace];
  const attempts = prepared.attempts + 1;
  const { outcome, read } = step;
  const status = await inTransaction(db, async (trx): Promise<OfferResponseStatus> => {
    const update = (values: {
      status: OfferResponseStatus;
      sent?: boolean;
      error?: { code: string; message: string; retryable: boolean };
      evidence?: true;
    }) =>
      trx
        .updateTable('offer_response')
        .set({
          status: values.status,
          attempts,
          ...(values.sent === true ? { sent: true } : {}),
          ...(values.evidence === true ? { success_evidence: 'read_back' as const } : {}),
          ...(values.error === undefined
            ? { error_code: null, error_message: null, retryable: false }
            : {
                error_code: values.error.code.slice(0, 100),
                error_message: values.error.message.slice(0, 500),
                retryable: values.error.retryable,
              }),
          ...(values.status === 'succeeded' || values.status === 'failed'
            ? { finished_at: sql<Date>`now()` }
            : {}),
        })
        .where('account_id', '=', prepared.accountId)
        .where('id', '=', prepared.responseId)
        .where('status', 'in', OPEN)
        .execute();
    const target = {
      accountId: prepared.accountId,
      connectionId: prepared.connectionId,
      marketplace: prepared.marketplace,
      responseId: prepared.responseId,
    };

    if (outcome !== null && outcome.type !== 'sent' && outcome.type !== 'unknown') {
      switch (outcome.type) {
        case 'refused':
          await update({
            status: 'failed',
            error: { code: outcome.code, message: outcome.message, retryable: false },
          });
          // What the offer is now shows in the inbox after the next read.
          await queueOfferCheck(trx, target);
          return 'failed';
        case 'needs_seller':
          await update({
            status: 'failed',
            error: { code: outcome.code, message: outcome.message, retryable: true },
          });
          return 'failed';
        case 'not_sent': {
          const sends = attempts;
          if (sends >= MAX_SENDS) {
            await update({
              status: 'failed',
              error: {
                code: outcome.code,
                message: `${outcome.message} Listora didn't send your answer. Try again.`,
                retryable: true,
              },
            });
            return 'failed';
          }
          await update({
            status: 'queued',
            error: { code: outcome.code, message: outcome.message, retryable: false },
          });
          await queueOfferResponse(trx, target, outcome.retryAfterMs ?? RESEND_DELAY_MS);
          return 'queued';
        }
      }
    }

    // The answer may have reached the marketplace: only the read decides, and it is never sent
    // again.
    const state = read !== null && 'state' in read ? read.state : null;
    if (state?.found === true && answerShown(prepared.request, state)) {
      await update({ status: 'succeeded', sent: true, evidence: true });
      await settleOffer(trx, prepared, state);
      return 'succeeded';
    }
    if (state !== null && !state.found) {
      await update({
        status: 'failed',
        sent: true,
        error: {
          code: 'offer_gone',
          message: `${name} no longer shows this offer, so Listora can't tell whether your answer went through. Check it in ${name}.`,
          retryable: false,
        },
      });
      await queueOfferCheck(trx, target);
      return 'failed';
    }
    if (state?.found === true && state.status !== 'pending') {
      await update({
        status: 'failed',
        sent: true,
        error: {
          code: 'answered_otherwise',
          message: `${name} shows this offer as ${state.status}, not as you answered it. Check it in ${name}.`,
          retryable: false,
        },
      });
      await queueOfferCheck(trx, target);
      return 'failed';
    }
    if (attempts >= MAX_ATTEMPTS) {
      await update({
        status: 'failed',
        sent: true,
        error: {
          code: 'not_confirmed',
          message: `Listora couldn't confirm that ${name} took your answer. Check the offer in ${name} before you answer again.`,
          retryable: false,
        },
      });
      return 'failed';
    }
    const readError = read !== null && 'error' in read ? read.error : null;
    await update({
      status: 'verifying',
      sent: true,
      error: {
        code: readError instanceof AutomationReadError ? readError.code : 'confirming',
        message: `Checking that ${name} took your answer.`,
        retryable: false,
      },
    });
    await queueOfferResponse(trx, target, READ_AGAIN_DELAY_MS);
    return 'verifying';
  });
  logger.info(
    {
      event: 'offer_answer_step',
      responseId: prepared.responseId,
      marketplace: prepared.marketplace,
      answer: prepared.request.answer,
      sent: outcome?.type ?? 'earlier',
      read:
        read === null
          ? null
          : 'state' in read
            ? read.state.found
              ? read.state.status
              : 'gone'
            : 'failed',
      status,
      attempts,
    },
    'offer answer step',
  );
  return status;
}

/** The answer was read back: the offer shows it, its task closes, and an accept checks for the sale. */
async function settleOffer(
  trx: DbExecutor,
  prepared: PreparedOfferAnswer,
  state: Extract<RemoteOfferState, { found: true }>,
): Promise<void> {
  const answer = prepared.request.answer;
  const status = answer === 'accept' ? 'accepted' : answer === 'decline' ? 'declined' : 'countered';
  await trx
    .updateTable('marketplace_offer')
    .set({
      status,
      closed_at: sql<Date>`now()`,
      amount_cents: state.offer.amountCents,
      last_seen_at: sql<Date>`now()`,
    })
    .where('account_id', '=', prepared.accountId)
    .where('id', '=', prepared.offerId)
    .execute();
  await closeOfferTasks(trx, prepared.accountId, [prepared.offerId], 'listora');
  if (answer === 'accept') {
    // The normal sale flow records the sale from the marketplace's own sold orders.
    await requestSaleCheck(trx, {
      accountId: prepared.accountId,
      marketplace: prepared.marketplace,
      reason: 'offer',
    });
  }
}
