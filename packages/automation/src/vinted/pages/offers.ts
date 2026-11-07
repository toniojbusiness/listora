/**
 * The buyers' offers on Vinted (docs/features/vinted.md, "Offers", M7). A Vinted offer lives in
 * the conversation between the buyer and the seller about the item: the buyer asks for a price
 * there, and the seller accepts, declines, or counters it there. So Listora reads offers from the
 * seller's conversations, through the reads Vinted's own inbox makes from its web API (from a
 * Vinted page, signed in by the session's cookies), and answers one on its own conversation:
 *
 * - `GET /api/v2/inbox?page=1&per_page=20`: the member's conversations, newest first
 *   (`conversations`, each with its `id`);
 * - `GET /api/v2/conversations/<id>`: one conversation, with the `transaction` it is about (its
 *   `id`, the `item_id` or a bundle's `item_ids`, `item_title`, and the `seller_id` and
 *   `buyer_id`), the `opposite_user` (the buyer's public `login`), and its `messages`, among
 *   them the offers (`entity_type` `offer_request_message`, the buyer's, or `offer_message`, the
 *   seller's counteroffer), each with its author (`user_id`), `price`, the listing's
 *   `original_price`, and `status`.
 *
 * The newest offer in a conversation is where it stands: the buyer's, pending, waits on the
 * seller; the seller's, pending, is their counteroffer and waits on the buyer; an accepted one is
 * accepted; a declined buyer's offer is declined; an expired or canceled one, or the seller's
 * counteroffer the buyer declined, is over. A conversation about an item the member bought (the
 * member is the buyer), or about no sale, holds no offer of the seller's. A status or author
 * Listora doesn't know stops the read (`PageChangedError`): an offer is never guessed.
 *
 * Listora's id of a Vinted offer is `<conversation id>/<transaction id>`: one negotiation per
 * conversation, whose amount moves as the buyer and the seller answer. Vinted's offers aren't
 * binding (an accepted one is a price the buyer may pay), and Vinted shows no expiry Listora has
 * read, so an offer's `expiresAt` is unknown.
 *
 * Modeled until the read-only mapping (Vinted plan M2) records the inbox and a conversation with
 * an offer: the paths, the fields, and the conversation page's offer controls. A shape that
 * differs stops the read, and its fix is this module. Only reads.
 */
import { z } from 'zod';

import type { OfferRef, RemoteOffer, RemoteOfferState } from '@listora/marketplaces';

import type { OfferPages } from '../../adapter/offer-page.ts';
import type { PageDriver } from '../../runner/types.ts';
import { VINTED_API_PATHS, VINTED_ID, VINTED_PATHS } from '../site.ts';
import { currentMember } from './account-page.ts';
import { priceCents } from './api.ts';
import { absolute, awaitElement, changed, type VintedSite } from './common.ts';

const API = 'web API';
const SIGNED_IN = { pageCookies: true } as const;

/** The newest conversations a read of the offers looks at (one inbox page). */
export const INBOX_PAGE_SIZE = 20;

/** The messages that are offers: the buyer's ask, and the seller's counteroffer. */
const OFFER_ENTITIES = ['offer_request_message', 'offer_message'] as const;

/**
 * The conversation page's offer controls, as Listora models them until the mapping (M2) reads a
 * conversation with an offer: the offer's card, with Accept, Decline, and Counter offer; the
 * confirmation each opens (Counter offer's with its price field); and Vinted's message when it
 * refuses the answer. The conversation's message box is never touched: Listora sends no message
 * of its own on Vinted, only the offer's own answer.
 */
export const CONVERSATION_PAGE = {
  card: '[data-testid="offer-request-card"]',
  amount: '[data-testid="offer-request-price"]',
  status: '[data-testid="offer-request-status"]',
  gone: '[data-testid="conversation-not-found"]',
  accept: 'button[data-testid="offer-request-accept"]',
  decline: 'button[data-testid="offer-request-decline"]',
  counter: 'button[data-testid="offer-request-counter"]',
  counterInput: '[data-testid="offer-counter-modal"] input[name="price"]',
  confirm: '[data-testid="offer-confirm-modal"] button[type="submit"]',
  error: '[data-testid="offer-request-error"]',
  /** The conversation's own message box: never typed in. */
  composer: '[data-testid="conversation-message-input"]',
} as const;

const id = z.union([z.number().int().nonnegative(), z.string().regex(VINTED_ID)]).transform(String);
const price = z.union([
  z.object({ amount: z.union([z.string(), z.number()]), currency_code: z.string().optional() }),
  z.string(),
  z.number(),
]);

const inboxSchema = z.object({
  conversations: z.array(z.object({ id }).catchall(z.unknown())),
});

const offerEntity = z
  .object({
    user_id: id,
    price,
    original_price: price.nullish(),
    status: z.string(),
    created_at: z.string().nullish(),
  })
  .catchall(z.unknown());

const messageSchema = z
  .object({
    entity_type: z.string(),
    entity: z.unknown(),
    created_at_ts: z.union([z.string(), z.number()]).nullish(),
  })
  .catchall(z.unknown());

const conversationSchema = z.object({
  conversation: z
    .object({
      id,
      opposite_user: z.object({ login: z.string().nullish() }).catchall(z.unknown()).nullish(),
      transaction: z
        .object({
          id,
          item_id: id.nullish(),
          item_ids: z.array(id).nullish(),
          item_title: z.string().nullish(),
          seller_id: id,
          buyer_id: id,
        })
        .catchall(z.unknown())
        .nullish(),
      messages: z.array(messageSchema),
    })
    .catchall(z.unknown()),
});
type Conversation = z.infer<typeof conversationSchema>['conversation'];

/** Where a conversation's offer stands, in Listora's terms. */
export type VintedOfferStatus =
  | Extract<RemoteOfferState, { found: true }>['status']
  /** Expired, canceled, or the seller's counteroffer the buyer declined: nothing waits. */
  | 'over';

/**
 * Where the newest offer stands by its status and whose it is; `null` for a status Listora
 * doesn't know.
 */
export function vintedOfferStatus(
  status: string,
  author: 'buyer' | 'seller',
): VintedOfferStatus | null {
  switch (status.trim().toLowerCase()) {
    case 'pending':
      return author === 'buyer' ? 'pending' : 'countered';
    case 'accepted':
      return 'accepted';
    case 'rejected':
    case 'declined':
      return author === 'buyer' ? 'declined' : 'over';
    case 'expired':
    case 'canceled':
    case 'cancelled':
    case 'withdrawn':
      return 'over';
    default:
      return null;
  }
}

/** Listora's id of a Vinted offer: its conversation and the transaction it is about. */
export function vintedOfferId(conversationId: string, transactionId: string): string {
  return `${conversationId}/${transactionId}`;
}

function splitOfferId(value: string): { conversationId: string; transactionId: string } | null {
  const [conversationId, transactionId, ...rest] = value.split('/');
  if (conversationId === undefined || transactionId === undefined || rest.length > 0) return null;
  if (!VINTED_ID.test(conversationId) || !VINTED_ID.test(transactionId)) return null;
  return { conversationId, transactionId };
}

/** The ids of the member's newest conversations, newest first. Only reads. */
export async function readConversationIds(page: PageDriver, site: VintedSite): Promise<string[]> {
  const query = new URLSearchParams({ page: '1', per_page: String(INBOX_PAGE_SIZE) });
  const answer = await page.apiGet(
    `${absolute(site, VINTED_API_PATHS.inbox)}?${query.toString()}`,
    SIGNED_IN,
  );
  if (answer.status !== 200) {
    throw changed(API, `answered ${String(answer.status)} for your conversations`);
  }
  const inbox = inboxSchema.safeParse(answer.body);
  if (!inbox.success) throw changed(API, "shows conversations Listora doesn't know");
  return inbox.data.conversations.slice(0, INBOX_PAGE_SIZE).map((one) => one.id);
}

/**
 * The offer in one of the member's conversations, as it stands; `null` for a conversation that
 * holds no offer of theirs (gone, about no sale, about an item the member bought, or with no
 * offer in it). Only reads.
 */
export async function readConversationOffer(
  page: PageDriver,
  site: VintedSite,
  memberId: string,
  conversationId: string,
): Promise<{ offer: RemoteOffer; status: VintedOfferStatus } | null> {
  const answer = await page.apiGet(
    absolute(site, VINTED_API_PATHS.conversation(conversationId)),
    SIGNED_IN,
  );
  if (answer.status === 404) return null;
  if (answer.status !== 200) {
    throw changed(API, `answered ${String(answer.status)} for a conversation`);
  }
  const parsed = conversationSchema.safeParse(answer.body);
  if (!parsed.success) throw changed(API, "shows a conversation Listora doesn't know");
  return conversationOffer(parsed.data.conversation, memberId, site);
}

/** The buyers' offers waiting on the seller in one conversation (none, or one). Only reads. */
export async function readPendingConversationOffer(
  page: PageDriver,
  site: VintedSite,
  memberId: string,
  conversationId: string,
): Promise<RemoteOffer[]> {
  const shown = await readConversationOffer(page, site, memberId, conversationId);
  return shown?.status === 'pending' ? [shown.offer] : [];
}

/** One offer as Vinted shows it now (an answer's read-back), from an open Vinted page. */
export async function readVintedOffer(
  page: PageDriver,
  site: VintedSite,
  ref: OfferRef,
): Promise<RemoteOfferState> {
  const ids = splitOfferId(ref.externalOfferId);
  if (ids === null) return { found: false };
  const member = await currentMember(page, site);
  const shown = await readConversationOffer(page, site, member.id, ids.conversationId);
  // Another sale in the same conversation is another offer: this one is over.
  if (shown?.offer.externalOfferId !== ref.externalOfferId) {
    return { found: false };
  }
  if (shown.status === 'over') return { found: false };
  return { found: true, offer: shown.offer, status: shown.status };
}

/**
 * Vinted's pages for an answer (adapter/offer-page.ts): the offer's conversation, read from the
 * web API, with the conversation page's offer controls. The page must draw the offer's card while
 * the offer waits on the seller; a page without it stops the answer as one Listora no longer
 * reads, and the seller answers in Vinted.
 */
export function vintedOfferPages(site: VintedSite): OfferPages {
  return {
    name: 'Vinted',
    selectors: CONVERSATION_PAGE,
    url: (ref) => conversationUrl(site, ref),
    read: async (page, ref) => {
      const shown = await readVintedOffer(page, site, ref);
      if (shown.found && shown.status === 'pending') {
        await awaitElement(page, CONVERSATION_PAGE.card, 'conversation', "buyer's offer");
      }
      return shown;
    },
  };
}

function conversationUrl(site: VintedSite, ref: OfferRef): string {
  const ids = splitOfferId(ref.externalOfferId);
  return absolute(site, VINTED_PATHS.conversation(ids?.conversationId ?? '0'));
}

function conversationOffer(
  conversation: Conversation,
  memberId: string,
  site: VintedSite,
): { offer: RemoteOffer; status: VintedOfferStatus } | null {
  const transaction = conversation.transaction;
  // A conversation about no sale, or about an item the member bought: no offer of the seller's.
  if (transaction?.seller_id !== memberId) {
    return null;
  }
  // Vinted lists a conversation's messages oldest first: the newest offer is where it stands.
  const newest = conversation.messages
    .filter((message) =>
      (OFFER_ENTITIES as readonly string[]).includes(message.entity_type.toLowerCase()),
    )
    .at(-1);
  if (newest === undefined) return null;
  const entity = offerEntity.safeParse(newest.entity);
  if (!entity.success) throw changed(API, "shows an offer Listora can't read");
  const author =
    entity.data.user_id === transaction.buyer_id
      ? 'buyer'
      : entity.data.user_id === transaction.seller_id
        ? 'seller'
        : null;
  if (author === null) throw changed(API, 'shows an offer from someone outside the sale');
  const status = vintedOfferStatus(entity.data.status, author);
  if (status === null) {
    throw changed(
      API,
      `shows an offer status Listora doesn't know (${entity.data.status.slice(0, 40)})`,
    );
  }
  const amountCents = priceCents(entity.data.price, undefined);
  if (amountCents <= 0) throw changed(API, 'shows an offer without its amount');
  const items = transaction.item_ids ?? [];
  const bundle = items.length > 1;
  const listingId = bundle ? null : (transaction.item_id ?? items[0] ?? null);
  const original = entity.data.original_price;
  return {
    status,
    offer: {
      externalOfferId: vintedOfferId(conversation.id, transaction.id),
      externalListingId: listingId,
      listingTitle: nonEmpty(transaction.item_title, 200),
      amountCents,
      listPriceCents:
        original === null || original === undefined ? null : priceCents(original, undefined),
      buyerName: nonEmpty(conversation.opposite_user?.login, 100),
      turn: status === 'pending' ? 'seller' : 'buyer',
      madeAt: iso(entity.data.created_at ?? newest.created_at_ts),
      // Vinted shows no expiry Listora has read.
      expiresAt: null,
      url: absolute(site, VINTED_PATHS.conversation(conversation.id)),
      listingCount: bundle ? Math.min(items.length, 500) : null,
      shippingCents: null,
    },
  };
}

/** The text trimmed and cut to `max`, or `null` when there is none. */
function nonEmpty(text: string | null | undefined, max: number): string | null {
  const trimmed = text?.trim() ?? '';
  return trimmed === '' ? null : trimmed.slice(0, max);
}

/** An ISO time from a time string or a Unix time in seconds or milliseconds. */
function iso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : null;
  const date =
    numeric === null ? new Date(value) : new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
