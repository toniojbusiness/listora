/**
 * The contract's `Offer`, `OfferResponse`, and `OfferCheck` (docs/features/offers.md): an offer
 * as the seller's session last read it, the answers Listora can send to it now, what accepting
 * gives after fees, and the newest answer in honest words: "Accepted (confirmed by Poshmark)"
 * only once a read of the offer showed it.
 */
import type { Offer, OfferCheck, OfferResponse } from '@listora/api-contract';
import { offerActions, offerMarketplaces, offerQuote } from '@listora/automation';
import type {
  DbExecutor,
  Marketplace,
  OfferAction,
  OfferResponseStatus,
  OfferStatus,
} from '@listora/db';
import { isOfferMarketplace, MARKETPLACE_NAMES, OFFER_RULES } from '@listora/marketplaces';

import type { Tenant } from '../tenancy.ts';

interface OfferRow {
  id: string;
  marketplace: Marketplace;
  status: OfferStatus;
  amount_cents: number;
  list_price_cents: number | null;
  listing_title: string | null;
  buyer_name: string | null;
  details: unknown;
  offer_url: string | null;
  made_at: Date | null;
  expires_at: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  /** The offer's connection is read only (docs/features/read-only.md): nothing is answered. */
  read_only: boolean;
}

interface ResponseRow {
  id: string;
  offer_id: string;
  action: OfferAction;
  status: OfferResponseStatus;
  offer_amount_cents: number;
  counter_cents: number | null;
  net_cents: number;
  error_code: string | null;
  error_message: string | null;
  retryable: boolean;
  created_at: Date;
  finished_at: Date | null;
}

const OPEN: readonly OfferResponseStatus[] = ['queued', 'running', 'verifying'];

/** The views of the account's offers among `offerIds`, by id. */
export async function offerViews(
  db: DbExecutor,
  tenant: Tenant,
  offerIds: readonly string[],
  now: Date,
): Promise<Map<string, Offer>> {
  // Only the offers of marketplaces whose offers Listora shows (verified-features.md).
  const marketplaces = offerMarketplaces();
  if (offerIds.length === 0 || marketplaces.length === 0) return new Map();
  const [offers, responses] = await Promise.all([
    db
      .selectFrom('marketplace_offer as offer')
      .innerJoin('marketplace_connection as connection', (join) =>
        join
          .onRef('connection.account_id', '=', 'offer.account_id')
          .onRef('connection.id', '=', 'offer.connection_id'),
      )
      .select([
        'offer.id',
        'offer.marketplace',
        'offer.status',
        'offer.amount_cents',
        'offer.list_price_cents',
        'offer.listing_title',
        'offer.buyer_name',
        'offer.details',
        'offer.offer_url',
        'offer.made_at',
        'offer.expires_at',
        'offer.first_seen_at',
        'offer.last_seen_at',
        'connection.read_only',
      ])
      .where('offer.account_id', '=', tenant.accountId)
      .where('offer.id', 'in', offerIds)
      .where('offer.marketplace', 'in', marketplaces)
      .execute(),
    db
      .selectFrom('offer_response')
      .select([
        'id',
        'offer_id',
        'action',
        'status',
        'offer_amount_cents',
        'counter_cents',
        'net_cents',
        'error_code',
        'error_message',
        'retryable',
        'created_at',
        'finished_at',
      ])
      .where('account_id', '=', tenant.accountId)
      .where('offer_id', 'in', offerIds)
      .orderBy('created_at', 'desc')
      .execute(),
  ]);
  const newest = new Map<string, ResponseRow>();
  for (const response of responses) {
    if (!newest.has(response.offer_id)) newest.set(response.offer_id, response);
  }
  return new Map(offers.map((offer) => [offer.id, offerView(offer, newest.get(offer.id), now)]));
}

function offerView(row: OfferRow, response: ResponseRow | undefined, now: Date): Offer {
  const details =
    typeof row.details === 'object' && row.details !== null
      ? (row.details as Record<string, unknown>)
      : {};
  const listingCount = details['listingCount'];
  const shippingCents = details['shippingCents'];
  const answering = response !== undefined && OPEN.includes(response.status);
  const open =
    row.status === 'pending' && (row.expires_at === null || row.expires_at > now) && !answering;
  const accept = offerQuote(row.marketplace, row.amount_cents, now);
  const answers = offerActions(row.marketplace);
  const name = MARKETPLACE_NAMES[row.marketplace];
  return {
    id: row.id,
    marketplace: row.marketplace,
    status: row.status,
    amount: usd(row.amount_cents),
    ...(row.list_price_cents === null ? {} : { listPrice: usd(row.list_price_cents) }),
    ...(row.listing_title === null ? {} : { listingTitle: row.listing_title }),
    ...(row.buyer_name === null ? {} : { buyerName: row.buyer_name }),
    ...(typeof listingCount === 'number' && listingCount > 1 ? { listingCount } : {}),
    ...(typeof shippingCents === 'number' ? { shipping: usd(shippingCents) } : {}),
    ...(row.made_at === null ? {} : { madeAt: row.made_at.toISOString() }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at.toISOString() }),
    ...(row.offer_url === null ? {} : { url: row.offer_url }),
    actions: open && !row.read_only ? answers : [],
    acceptNote: row.read_only
      ? `This ${name} account is read only in Listora. Answer this offer in ${name}.`
      : answers.length === 0
        ? // Answers from Listora haven't passed live here yet (verified-features.md).
          `Answer this offer in ${name}.`
        : isOfferMarketplace(row.marketplace)
          ? OFFER_RULES[row.marketplace].acceptNote
          : 'Accepting lets the buyer buy it at this price.',
    accept: {
      price: usd(accept.priceCents),
      fees: usd(accept.feesCents),
      net: usd(accept.netCents),
    },
    ...(answers.includes('counter')
      ? {
          counterRange: {
            above: usd(row.amount_cents),
            ...(row.list_price_cents === null ? {} : { below: usd(row.list_price_cents) }),
          },
        }
      : {}),
    ...(response === undefined ? {} : { response: responseView(response, row.marketplace) }),
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}

export function responseView(row: ResponseRow, marketplace: Marketplace): OfferResponse {
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    statusText: responseStatusText(row, marketplace),
    offerAmount: usd(row.offer_amount_cents),
    ...(row.counter_cents === null ? {} : { counter: usd(row.counter_cents) }),
    net: usd(row.net_cents),
    ...(row.status === 'failed' && row.error_message !== null
      ? {
          error: {
            code: row.error_code ?? 'failed',
            message: row.error_message,
            retryable: row.retryable,
          },
        }
      : {}),
    createdAt: row.created_at.toISOString(),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at.toISOString() }),
  };
}

/** The answer's status in the seller's words, never claiming more than the read-back showed. */
function responseStatusText(
  row: Pick<ResponseRow, 'action' | 'status' | 'counter_cents'>,
  marketplace: Marketplace,
): string {
  const name = MARKETPLACE_NAMES[marketplace];
  const doing =
    row.action === 'accept'
      ? 'Accepting'
      : row.action === 'decline'
        ? 'Declining'
        : `Countering at ${dollars(row.counter_cents ?? 0)}`;
  switch (row.status) {
    case 'queued':
    case 'running':
      return `${doing} on your iPhone...`;
    case 'verifying':
      return `${doing}... checking that ${name} took it`;
    case 'succeeded':
      return row.action === 'accept'
        ? `Accepted (confirmed by ${name})`
        : row.action === 'decline'
          ? `Declined (confirmed by ${name})`
          : `Countered at ${dollars(row.counter_cents ?? 0)} (confirmed by ${name})`;
    case 'failed':
      return row.action === 'accept'
        ? 'Not accepted'
        : row.action === 'decline'
          ? 'Not declined'
          : 'Counteroffer not sent';
  }
}

/** When each linked marketplace's offers were read, and how the newest read went. */
export async function offerCheckViews(db: DbExecutor, tenant: Tenant): Promise<OfferCheck[]> {
  const marketplaces = offerMarketplaces();
  if (marketplaces.length === 0) return [];
  const rows = await db
    .selectFrom('marketplace_connection as connection')
    .leftJoin('offer_check as oc', (join) =>
      join
        .onRef('oc.account_id', '=', 'connection.account_id')
        .onRef('oc.connection_id', '=', 'connection.id'),
    )
    .leftJoin('phone_work as work', (join) =>
      join
        .onRef('work.account_id', '=', 'connection.account_id')
        .onRef('work.connection_id', '=', 'connection.id')
        .on('work.purpose', '=', 'offer_check'),
    )
    .select([
      'connection.marketplace',
      'oc.last_succeeded_at',
      'oc.last_outcome',
      'work.id as waiting',
    ])
    .where('connection.account_id', '=', tenant.accountId)
    .where('connection.mode', '=', 'automation')
    .where('connection.status', 'in', ['connected', 'degraded'])
    .where('connection.marketplace', 'in', marketplaces)
    .orderBy('connection.marketplace')
    .execute();
  // A failed read's reason is the owner's (read-health.md), never an error for the seller.
  return rows.map((row) => ({
    marketplace: row.marketplace,
    status: row.waiting !== null ? 'waiting' : row.last_outcome === 'failed' ? 'failed' : 'ok',
    ...(row.last_succeeded_at === null ? {} : { checkedAt: row.last_succeeded_at.toISOString() }),
  }));
}

function usd(amountCents: number) {
  return { amountCents, currency: 'USD' as const };
}

function dollars(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? `$${String(whole)}` : `$${String(whole)}.${String(rest).padStart(2, '0')}`;
}
