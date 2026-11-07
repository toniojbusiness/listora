/**
 * The fake Vinted site's conversations with offers (Vinted plan M7, `pages/offers.ts`): the web
 * API's inbox and conversation records, and the conversation page with the buyer's offer card,
 * its answers and their confirmation, and the conversation's own message box. Invented, as
 * Listora models Vinted's pages until the mapping (M2) records a conversation with an offer.
 * Development and tests only.
 */
import type { FakeOffer } from '../../fake-offers/fake-offers.ts';
import { CONVERSATION_PAGE } from '../pages/offers.ts';
import { escape } from './listing-pages.ts';

/** One conversation as the fake keeps it: the offer it carries, and who sells. */
export interface FakeVintedConversation {
  id: string;
  transactionId: string;
  /** The buyer's member id. */
  buyerId: string;
  /** The seller's member id (the member signed in, unless they are the buyer). */
  sellerId: string;
  /** The items the sale is about: several for a bundle. */
  itemIds: string[];
  offer: FakeOffer;
}

/** A status the newest offer shows instead of its own (a status Listora doesn't know). */
export type StatusOverride = string | null;

/** A conversation's record, as `GET /api/v2/conversations/<id>` answers it. */
export function conversationJson(
  conversation: FakeVintedConversation,
  memberId: string,
  override: StatusOverride,
): Record<string, unknown> {
  const { offer } = conversation;
  const buyerPrice = offer.buyerAmountCents ?? offer.amountCents;
  // The buyer's ask, once the seller countered it, was turned down for the counter.
  const buyerStatus =
    offer.status === 'pending' ? 'pending' : offer.status === 'accepted' ? 'accepted' : 'rejected';
  const messages: Record<string, unknown>[] = [
    {
      entity_type: 'message',
      entity: { body: 'Hi! Would you take less for it?', user_id: Number(conversation.buyerId) },
      created_at_ts: offer.createdAt,
    },
  ];
  const sellersOffer = offer.status === 'countered' || offer.sentBySeller === true;
  if (offer.sentBySeller !== true) {
    messages.push({
      entity_type: 'offer_request_message',
      entity: {
        user_id: Number(conversation.buyerId),
        price: { amount: amount(buyerPrice), currency_code: 'USD' },
        original_price: { amount: amount(offer.listPriceCents), currency_code: 'USD' },
        status: !sellersOffer && override !== null ? override : buyerStatus,
        created_at: offer.createdAt,
      },
      created_at_ts: offer.createdAt,
    });
  }
  if (sellersOffer) {
    messages.push({
      entity_type: 'offer_message',
      entity: {
        user_id: Number(conversation.sellerId),
        price: { amount: amount(offer.amountCents), currency_code: 'USD' },
        original_price: { amount: amount(offer.listPriceCents), currency_code: 'USD' },
        status: override ?? 'pending',
      },
    });
  }
  const bundle = conversation.itemIds.length > 1;
  return {
    conversation: {
      id: Number(conversation.id),
      // The other member: the buyer, or the seller of an item the member bought.
      opposite_user: {
        id: Number(
          conversation.sellerId === memberId ? conversation.buyerId : conversation.sellerId,
        ),
        login: offer.buyer,
      },
      transaction: {
        id: Number(conversation.transactionId),
        item_id: Number(conversation.itemIds[0] ?? offer.listingId),
        ...(bundle ? { item_ids: conversation.itemIds.map(Number) } : {}),
        item_title: offer.listingTitle,
        seller_id: Number(conversation.sellerId),
        buyer_id: Number(conversation.buyerId),
      },
      messages,
    },
  };
}

/**
 * The conversation page (`/inbox/<id>`): the messages, the buyer's offer card with Accept,
 * Decline, and Counter offer while it waits on the seller, the confirmation one opens
 * (`confirm`), Vinted's refusal (`error`), and the message box. `redesigned`: no offer card.
 */
export function conversationPage(
  conversation: FakeVintedConversation,
  confirm: string | null,
  error: string | null,
  redesigned: boolean,
): string {
  const { offer } = conversation;
  const path = `/inbox/${conversation.id}`;
  const waiting = offer.status === 'pending' && offer.sentBySeller !== true;
  const status =
    offer.status === 'pending'
      ? offer.sentBySeller === true
        ? 'Waiting for the buyer'
        : 'Waiting for your answer'
      : offer.status === 'countered'
        ? 'Counteroffer sent'
        : offer.status === 'accepted'
          ? 'Offer accepted'
          : 'Offer declined';
  const answers = waiting
    ? `<a href="${path}?confirm=accept"><button type="button" data-testid="offer-request-accept">Accept</button></a>
<a href="${path}?confirm=decline"><button type="button" data-testid="offer-request-decline">Decline</button></a>
<a href="${path}?confirm=counter"><button type="button" data-testid="offer-request-counter">Counter offer</button></a>`
    : '';
  const modal =
    waiting && (confirm === 'accept' || confirm === 'decline' || confirm === 'counter')
      ? `<form method="post" action="${path}/offer" data-testid="offer-confirm-modal">
<input type="hidden" name="action" value="${confirm}">
${confirm === 'counter' ? '<div data-testid="offer-counter-modal"><label>Your price <input name="price" inputmode="decimal"></label></div>' : ''}
<button type="submit">${confirm === 'accept' ? 'Accept offer' : confirm === 'decline' ? 'Decline offer' : 'Send offer'}</button>
</form>`
      : '';
  const card = redesigned
    ? ''
    : `<section data-testid="offer-request-card">
<p>Offer <span data-testid="offer-request-price">$${dollars(offer.amountCents)}</span></p>
<p data-testid="offer-request-status">${status}</p>
${error === null ? '' : `<p role="alert" data-testid="offer-request-error">${escape(error)}</p>`}
${answers}
${modal}
</section>`;
  const composer = CONVERSATION_PAGE.composer.replace(/^\[data-testid="(.*)"\]$/, '$1');
  return `<main>
<h1>${escape(offer.buyer)}</h1>
<ol data-testid="conversation-messages"><li>Hi! Would you take less for it?</li></ol>
${card}
<form method="post" action="${path}/messages"><textarea name="body" data-testid="${composer}"></textarea><button type="submit">Send</button></form>
</main>`;
}

/** Cents as Vinted's amounts show them: `"18.0"`, `"18.5"`, `"18.25"`. */
export function amount(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0
    ? `${String(whole)}.0`
    : `${String(whole)}.${String(rest).padStart(2, '0').replace(/0$/, '')}`;
}

function dollars(cents: number): string {
  return `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}
