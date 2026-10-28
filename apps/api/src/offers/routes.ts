import {
  OfferAnswerRefusedError,
  offerActions,
  offerQuote,
  requestOfferAnswer,
  requestOfferChecks,
} from '@listora/automation';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import type { Tenant } from '../tenancy.ts';
import type { DbExecutor } from '@listora/db';

import { offerCheckViews, offerViews, responseView } from './views.ts';

export interface OfferRouteDependencies extends RouteDependencies {
  now: () => Date;
}

/**
 * Offers (docs/features/offers.md). Reading them only reads; an answer is sent only for the
 * seller's confirmed tap, once, from their iPhone, and is shown as done only once a read of the
 * offer shows it.
 */
export function registerOfferRoutes(app: FastifyInstance, deps: OfferRouteDependencies): void {
  contractRoute(app, deps, 'listOfferChecks', async ({ tenant, db }) => ({
    status: 200,
    body: { data: await offerCheckViews(db, tenant) },
  }));

  contractRoute(app, deps, 'requestOfferChecks', async ({ tenant, db }) => {
    await requestOfferChecks(db, { accountId: tenant.accountId });
    return { status: 200, body: { data: await offerCheckViews(db, tenant) } };
  });

  contractRoute(app, deps, 'getOffer', async ({ tenant, db, params }) => ({
    status: 200,
    body: await oneOffer(db, tenant, params.offerId, deps.now()),
  }));

  contractRoute(app, deps, 'getOfferQuote', async ({ tenant, db, params, query }) => {
    const offer = await db
      .selectFrom('marketplace_offer')
      .select(['marketplace'])
      .where('account_id', '=', tenant.accountId)
      .where('id', '=', params.offerId)
      .executeTakeFirst();
    if (offer === undefined) throw notFound('Offer');
    if (offerActions(offer.marketplace).length === 0) {
      throw new ApiError('marketplace_action_unavailable', "Listora doesn't answer these offers.");
    }
    const quote = offerQuote(offer.marketplace, query.priceCents, deps.now());
    return {
      status: 200,
      body: {
        price: usd(quote.priceCents),
        fees: usd(quote.feesCents),
        net: usd(quote.netCents),
      },
    };
  });

  contractRoute(app, deps, 'answerOffer', async ({ tenant, db, params, body, request }) => {
    const now = deps.now();
    let responseId: string;
    try {
      ({ responseId } = await requestOfferAnswer(db, {
        accountId: tenant.accountId,
        offerId: params.offerId,
        action: body.action,
        offerAmountCents: body.offerAmount.amountCents,
        counterCents: body.counter?.amountCents ?? null,
        idempotencyKey: String(request.headers['idempotency-key']),
        now,
      }));
    } catch (error) {
      throw refusal(error);
    }
    const response = await db
      .selectFrom('offer_response as response')
      .innerJoin('marketplace_offer as offer', (join) =>
        join
          .onRef('offer.account_id', '=', 'response.account_id')
          .onRef('offer.id', '=', 'response.offer_id'),
      )
      .select([
        'response.id',
        'response.offer_id',
        'response.action',
        'response.status',
        'response.offer_amount_cents',
        'response.counter_cents',
        'response.net_cents',
        'response.error_code',
        'response.error_message',
        'response.retryable',
        'response.created_at',
        'response.finished_at',
        'offer.marketplace',
      ])
      .where('response.account_id', '=', tenant.accountId)
      .where('response.id', '=', responseId)
      .executeTakeFirstOrThrow();
    return { status: 202, body: responseView(response, response.marketplace) };
  });
}

async function oneOffer(db: DbExecutor, tenant: Tenant, offerId: string, now: Date) {
  const offer = (await offerViews(db, tenant, [offerId], now)).get(offerId);
  if (offer === undefined) throw notFound('Offer');
  return offer;
}

function refusal(error: unknown): unknown {
  if (!(error instanceof OfferAnswerRefusedError)) return error;
  switch (error.code) {
    case 'not_found':
      return notFound('Offer');
    case 'offer_closed':
    case 'answer_in_progress':
      return new ApiError('invalid_state_transition', error.message, { cause: error });
    case 'unavailable':
      return new ApiError('marketplace_action_unavailable', error.message, { cause: error });
    case 'invalid':
      return validationFailed([{ field: 'body', message: error.message }]);
  }
}

function usd(amountCents: number) {
  return { amountCents, currency: 'USD' as const };
}
