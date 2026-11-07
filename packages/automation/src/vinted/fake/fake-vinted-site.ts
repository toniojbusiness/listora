/**
 * The fake Vinted site: a local web app with the pages of Vinted's US site that the Vinted
 * automation adapter uses (docs/features/vinted.md), for its development and tests. No test
 * sends traffic to Vinted. It mirrors Vinted's pages as the adapter's page modules model them
 * (`pages/`): the same paths and selectors, invented, until the read-only mapping of Vinted's
 * pages (Vinted plan M2) records the real ones. It serves signing in and the session check (M3),
 * and the seller's wardrobe and sold orders from the web API that the listings and orders reads
 * use (M4, `pages/api.ts`), with Vinted's checks as fault injection. One seller's wardrobe and
 * orders, whoever is signed in (`items`, `orders`).
 *
 *   GET  /member/signup/select_type   the sign-up and sign-in chooser (a password field: no session needs it)
 *   POST /member/signup/select_type   sign in by hand: any login and password; sets the session cookie
 *   GET  /member/verification         a sign-in code step
 *   GET  /settings/profile            the member's profile settings, with the header's user menu
 *   GET  /                            the home page, with the same header
 *   GET  /api/v2/users/current        the member signed in (web API): their id and login
 *   GET  /api/v2/wardrobe/<id>/items  the member's wardrobe (web API), newest first, a page at a time
 *   GET  /api/v2/items/<id>           one item (web API), with its description
 *   GET  /api/v2/my_orders            the member's sold orders (web API), `type=sold&status=...`
 *   GET  /api/v2/transactions/<id>    one order (web API), with the items that sold in it
 *   GET  /items/new                   the upload form; POST /items/new uploads (multipart, photos)
 *   GET  /items/<id>/edit             the listing's edit form; POST saves it (its price, title, text)
 *   GET  /items/<id>                  the listing's page, with its seller's Hide or Unhide
 *   POST /items/<id>/hide, /unhide    hides the listing, or puts it back on sale
 *   GET  /api/v2/inbox                the member's conversations (web API), newest first (M7)
 *   GET  /api/v2/conversations/<id>   one conversation (web API): its sale and messages, offers among them
 *   GET  /inbox/<id>                  a conversation, with the buyer's offer card and the message box
 *   POST /inbox/<id>/offer            answers the offer (accept, decline, counter at `price`)
 *   POST /inbox/<id>/messages         sends a message (recorded: Listora must never send one)
 *   GET  /users/verification          Vinted's account verification before listing
 *   GET  /media/<name>.jpg            a listing photo on the fake's image CDN (fake-photos.ts)
 *
 * A new upload goes live at once, or into Vinted's review first while `reviewUploads` is set
 * (until `finishReview`): its seller has it, its web API record says it is being processed, and
 * its page offers no Hide.
 *
 * Every page except the sign-in pages needs the session cookie; without a valid one it
 * redirects to the sign-in chooser, as Vinted does.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SessionCookie } from '@listora/connections';

import { FAKE_MEDIA_PATH, fakeMediaName, fakeMediaPhoto } from '../../fake-photos/fake-photos.ts';
import { splitSkuLine } from '../../adapter/sku-line.ts';
import { FakeOfferDesk, type FakeOffer } from '../../fake-offers/fake-offers.ts';
import { itemIdFromPath, VINTED_LOGIN_PATH, VINTED_PATHS } from '../site.ts';
import {
  EMPTY_FORM,
  escape,
  FAKE_VINTED_CATEGORIES,
  itemPage,
  uploadForm,
  type FormValues,
} from './listing-pages.ts';
import { conversationJson, conversationPage, type FakeVintedConversation } from './offer-pages.ts';

/** Vinted's session cookie, as the fake names it. */
const SESSION_COOKIE = '_vinted_fr_session';

/**
 * What a fault is injected into: the session check (the settings page every web API read opens
 * first), the wardrobe and item reads, the orders, the upload form's page, a listing's page, an
 * Upload, an edit's Save, a Hide, or an Unhide.
 */
export type FakeVintedAction =
  | 'health'
  | 'listings'
  | 'orders'
  | 'upload_page'
  | 'item_page'
  | 'create'
  | 'update'
  | 'end'
  | 'relist'
  /** The inbox and conversation reads of the web API (M7). */
  | 'offers'
  /** A conversation's page, where an offer is answered. */
  | 'conversation_page';

export type FakeVintedFault =
  /** DataDome's challenge drawn in the page instead of the settings (status 403). */
  | { type: 'datadome' }
  /** A visible CAPTCHA widget over the page. */
  | { type: 'captcha' }
  /** A redirect to a sign-in code step. */
  | { type: 'login_challenge' }
  /** The session is invalidated, and the page redirects to the sign-in chooser. */
  | { type: 'session_expired' }
  | { type: 'rate_limited'; retryAfterSeconds?: number }
  /** A 5xx; with `afterApply`, the change was made before it. */
  | { type: 'server_error'; afterApply?: boolean }
  /** Vinted's message under a field of the upload form, nothing changed. */
  | { type: 'reject'; message: string }
  /** The answer comes after `delayMs`; with `afterApply`, the change was made first. */
  | { type: 'slow'; delayMs: number; afterApply: boolean }
  /** The next item read shows the item as it was before its latest change. */
  | { type: 'stale_read' }
  /** Vinted's account verification before listing, as the test account met it. */
  | { type: 'account_verification' }
  /** The page without the header's user menu, as after a site redesign. */
  | { type: 'redesigned' }
  /** The web API's member signed in without a login. */
  | { type: 'no_login' }
  /** A web API read answered as DataDome answers a call it blocks: 403, JSON naming its page. */
  | { type: 'datadome_api' }
  /** A web API read answered in a shape Listora doesn't know, as after an API change. */
  | { type: 'unknown_shape' }
  /**
   * A web API read refused until the member verifies their account (a phone number), as Vinted
   * answers the sold orders of a member who has not (400, `user_verification_required`).
   */
  | { type: 'verification_required' };

export interface FakeVintedFaultRule {
  action: FakeVintedAction;
  fault: FakeVintedFault;
  /** How many matching requests get it (default 1). */
  times?: number;
}

interface Member {
  id: string;
  login: string;
}

/** One of the seller's items, as the fake keeps it. */
export interface FakeVintedItem {
  id: string;
  title: string;
  description: string;
  priceCents: number;
  /** For sale, hidden by the seller, reserved for a buyer, sold, or a draft. */
  state: 'active' | 'hidden' | 'reserved' | 'sold' | 'draft';
  brand: string | null;
  size: string | null;
  /** Vinted's condition label (`Very good`). */
  condition: string | null;
  catalogId: number | null;
  /** Vinted's colour names (`Black`, `Light blue`). */
  colors: string[];
  /** The photos' names on the fake's image CDN, cover first. */
  photos: string[];
  /** Its category's names, top first, when it was uploaded here. */
  category?: string[];
  /** Its package size, when it was uploaded here. */
  packageSize?: 'small' | 'medium' | 'large';
  /** Vinted is reviewing it: its seller has it, buyers don't see it yet. */
  inReview?: boolean;
}

/** Vinted's words for an order (modeled until the mapping records them). */
function orderWords(order: FakeVintedOrder): string {
  if (order.state === 'completed') return 'Order completed';
  if (order.state === 'canceled') return 'Order canceled';
  switch (order.progress ?? 'to_ship') {
    case 'unpaid':
      return 'Waiting for payment';
    case 'to_ship':
      return 'Payment successful';
    case 'shipped':
      return 'Parcel on its way';
    case 'delivered':
      return 'Parcel delivered';
  }
}

/** One sold order, as the fake keeps it. */
export interface FakeVintedOrder {
  id: string;
  /** When the buyer paid. */
  paidAt: Date;
  state: 'in_progress' | 'completed' | 'canceled';
  /**
   * Where an order in progress stands (default `to_ship`): `unpaid` is an accepted offer the
   * buyer has not paid for yet. Each is shown in Vinted's words (`status`).
   */
  progress?: 'unpaid' | 'to_ship' | 'shipped' | 'delivered';
  /** Vinted's words for it, in place of the ones its state and progress give. */
  statusText?: string;
  /** The items that sold in it: several for a bundle. */
  itemIds: string[];
  /** What the buyer paid for the items, without Vinted's buyer fee. */
  priceCents: number;
  title: string;
}

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export class FakeVintedSite {
  readonly #server: Server;
  readonly #sessions = new Map<string, Member>();
  readonly #faults: { rule: FakeVintedFaultRule; left: number }[] = [];
  #url = '';
  #nextMember = 4_100_000;
  /** Every request, in order: its path and the status it got. */
  readonly requests: { method: string; path: string; status: number }[] = [];
  /** The seller's items, newest first. */
  items: FakeVintedItem[] = [];
  /** The seller's sold orders, newest first. */
  orders: FakeVintedOrder[] = [];
  /** The most the web API puts on one page, whatever a read asks for. */
  maxPageSize = 96;
  /** New uploads go into Vinted's review before they go live (until `finishReview`). */
  reviewUploads = false;
  #nextItem = 7_400_000_000;
  /** Each item as it was before its latest change, for a stale read. */
  readonly #previous = new Map<string, FakeVintedItem>();
  /** The next answer for the member signed in shows no login (the `no_login` fault). */
  #hideLogin = false;
  /** Buyers' offers on the seller's items, each in its own conversation, and the answers taken. */
  readonly offers = new FakeOfferDesk();
  /** Offers in conversations where the member is the buyer (an item they bought). */
  readonly boughtByMember = new Set<string>();
  /** A bundle offer's items, by its offer id. */
  readonly bundles = new Map<string, string[]>();
  /** Conversations about no sale (a question). */
  chats = 0;
  /** A status every conversation's newest offer shows instead of its own. */
  offerStatusOverride: string | null = null;
  /** Every message sent in a conversation: Listora must never send one. */
  readonly messages: { conversationId: string; body: string }[] = [];
  readonly #conversationIds = new Map<string, { id: string; transactionId: string }>();
  #nextConversation = 9_100_000;

  private constructor() {
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch(() => {
        response.writeHead(500).end();
      });
    });
  }

  static async start(port = 0): Promise<FakeVintedSite> {
    const site = new FakeVintedSite();
    await new Promise<void>((resolve, reject) => {
      site.#server.once('error', reject);
      site.#server.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
    const { port: bound } = site.#server.address() as AddressInfo;
    site.#url = `http://127.0.0.1:${String(bound)}`;
    return site;
  }

  get url(): string {
    return this.#url;
  }

  /** The cookie a member's signed-in browser holds, as the app would hand it to Listora. */
  issueSession(login = 'fake-vinted-member'): SessionCookie {
    const token = randomBytes(16).toString('hex');
    this.#nextMember += 1;
    this.#sessions.set(token, { id: String(this.#nextMember), login });
    return {
      name: SESSION_COOKIE,
      value: token,
      domain: '127.0.0.1',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 86_400,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    };
  }

  injectFault(rule: FakeVintedFaultRule): void {
    this.#faults.push({ rule, left: rule.times ?? 1 });
  }

  clearFaults(): void {
    this.#faults.length = 0;
  }

  /** Vinted finishes reviewing the item: it goes live. */
  finishReview(id: string): void {
    const found = this.items.find((one) => one.id === id);
    if (found !== undefined) found.inReview = false;
  }

  /** The conversation an offer is in (its id and its sale's), made the first time it is asked. */
  conversationOf(offerId: string): { id: string; transactionId: string } {
    let ids = this.#conversationIds.get(offerId);
    if (ids === undefined) {
      this.#nextConversation += 1;
      ids = {
        id: String(this.#nextConversation),
        transactionId: String(this.#nextConversation + 50_000_000),
      };
      this.#conversationIds.set(offerId, ids);
    }
    return ids;
  }

  /** The member's conversations with offers, newest first. */
  #conversations(member: Member): FakeVintedConversation[] {
    return this.offers
      .all()
      .reverse()
      .map((offer: FakeOffer) => {
        const ids = this.conversationOf(offer.id);
        const bought = this.boughtByMember.has(offer.id);
        const other = String(Number(ids.id) + 1_000_000);
        return {
          ...ids,
          buyerId: bought ? member.id : other,
          sellerId: bought ? other : member.id,
          itemIds: this.bundles.get(offer.id) ?? [offer.listingId],
          offer,
        };
      });
  }

  /** The ids of the conversations about no sale. */
  #chatIds(): string[] {
    return Array.from({ length: this.chats }, (_, n) => String(8_100_000 + n));
  }

  /** The seller's items whose description ends with Listora's line for this SKU. */
  itemsWithSku(sku: string): FakeVintedItem[] {
    return this.items.filter((one) => splitSkuLine(one.description).sku === sku);
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  // Requests ----------------------------------------------------------------------------------

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.#url);
    const method = request.method ?? 'GET';
    const record = { method, path: url.pathname, status: 0 };
    this.requests.push(record);
    const send = (reply: Reply): void => {
      record.status = reply.status;
      response.writeHead(reply.status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        ...reply.headers,
      });
      response.end(reply.body ?? '');
    };

    if (url.pathname === VINTED_LOGIN_PATH) {
      if (method === 'POST') {
        // The member signs in by hand, as on the app's Link accounts screen in development: any
        // login with a password starts a session as that member.
        const form = new URLSearchParams(await readBody(request));
        const login = form.get('login')?.trim() ?? '';
        if (login !== '' && (form.get('password') ?? '') !== '') {
          const { value } = this.issueSession(login);
          send({
            status: 303,
            headers: {
              location: '/',
              'set-cookie': `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
            },
          });
          return;
        }
      }
      send({ status: 200, body: page('Sign up | Vinted', loginForm()) });
      return;
    }
    if (url.pathname === '/member/verification') {
      send({
        status: 200,
        body: page('Verify it’s you | Vinted', '<p>Enter the verification code we sent you.</p>'),
      });
      return;
    }

    const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
    const member = token === undefined ? undefined : this.#sessions.get(token);
    if (member === undefined || token === undefined) {
      send(redirectToLogin(url.pathname));
      return;
    }

    const media = FAKE_MEDIA_PATH.exec(url.pathname)?.[1];
    if (media !== undefined) {
      record.status = 200;
      const photo = await fakeMediaPhoto(media);
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      response.end(photo);
      return;
    }

    if (url.pathname.startsWith('/api/v2/')) {
      send(this.#api(url, member));
      return;
    }

    if (url.pathname === '/users/verification') {
      send({
        status: 200,
        body: page(
          'Verify your email | Vinted',
          '<h1>Verify your email to keep your account secure</h1><p>Enter the code we sent you.</p>',
        ),
      });
      return;
    }

    const conversationReply = await this.#conversationPages(request, url, method, member);
    if (conversationReply !== null) {
      send(conversationReply);
      return;
    }

    const listingReply = await this.#listingPages(request, url, method, member);
    if (listingReply !== null) {
      send(listingReply);
      return;
    }

    if (url.pathname === VINTED_PATHS.account || url.pathname === '/') {
      const fault = url.pathname === VINTED_PATHS.account ? this.#takeFault('health') : null;
      if (fault?.type === 'no_login') this.#hideLogin = true;
      if (fault !== null) {
        const reply = this.#faultReply(fault, token, url.pathname, member);
        if (reply !== null) {
          send(reply);
          return;
        }
      }
      const title = url.pathname === '/' ? 'Vinted' : 'Profile settings | Vinted';
      send({
        status: 200,
        body: page(
          title,
          `${header(member, fault?.type === 'redesigned' ? 'none' : 'shown')}<main><h1>Profile details</h1><form><label>About you <textarea name="about"></textarea></label></form></main>${fault?.type === 'captcha' ? '<div class="g-recaptcha" data-sitekey="fake" style="width:300px;height:80px"></div>' : ''}`,
        ),
      });
      return;
    }
    send({ status: 404, body: page('Page not found | Vinted', '<h1>Page not found</h1>') });
  }

  /** The next fault for the action, used up once its `times` are. */
  #takeFault(action: FakeVintedAction): FakeVintedFault | null {
    const index = this.#faults.findIndex((entry) => entry.rule.action === action);
    const entry = this.#faults[index];
    if (entry === undefined) return null;
    entry.left -= 1;
    if (entry.left <= 0) this.#faults.splice(index, 1);
    return entry.rule.fault;
  }

  /** The web API: the member's own wardrobe, items, and sold orders. Only GETs. */
  #api(url: URL, member: Member): Reply {
    const path = url.pathname;
    if (path === '/api/v2/users/current') {
      const login = this.#hideLogin ? null : member.login;
      this.#hideLogin = false;
      return json(200, { user: { id: Number(member.id), login, real_name: null }, code: 0 });
    }
    if (path === '/api/v2/inbox' || path.startsWith('/api/v2/conversations/')) {
      return this.#conversationApi(url, member);
    }
    const wardrobe = /^\/api\/v2\/wardrobe\/(\d+)\/items$/.exec(path);
    const item = /^\/api\/v2\/items\/(\d+)$/.exec(path);
    const transaction = /^\/api\/v2\/transactions\/(\d+)$/.exec(path);
    const action: FakeVintedAction | null =
      wardrobe !== null || item !== null
        ? 'listings'
        : path === '/api/v2/my_orders' || transaction !== null
          ? 'orders'
          : null;
    if (action === null) return json(404, { code: 404, message: 'Not found' });
    const fault = this.#takeFault(action);
    if (fault !== null) {
      const reply = apiFaultReply(fault);
      if (reply !== null) return reply;
    }
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const size = Math.min(
      this.maxPageSize,
      Math.max(1, Number(url.searchParams.get('per_page') ?? '20') || 20),
    );
    const paged = <T>(all: readonly T[]): { shown: T[]; pagination: Record<string, number> } => ({
      shown: all.slice((page - 1) * size, page * size),
      pagination: {
        current_page: page,
        total_pages: Math.max(1, Math.ceil(all.length / size)),
        total_entries: all.length,
        per_page: size,
      },
    });
    if (wardrobe !== null) {
      // Only the member's own wardrobe holds the seller's items here.
      const own =
        wardrobe[1] === member.id ? this.items.filter((one) => one.state !== 'draft') : [];
      const { shown, pagination } = paged(own);
      return json(200, { items: shown.map((one) => this.#itemJson(one, false)), pagination });
    }
    if (item !== null) {
      const current = this.items.find((one) => one.id === item[1]);
      const found =
        fault?.type === 'stale_read' && current !== undefined
          ? (this.#previous.get(current.id) ?? current)
          : current;
      return found === undefined
        ? json(404, { code: 404, message: 'Item not found' })
        : json(200, { item: this.#itemJson(found, true) });
    }
    if (transaction !== null) {
      const order = this.orders.find((one) => one.id === transaction[1]);
      if (order === undefined) return json(404, { code: 404, message: 'Not found' });
      const items = order.itemIds.flatMap((id) => {
        const found = this.items.find((one) => one.id === id);
        return found === undefined ? [] : [this.#itemJson(found, true)];
      });
      return json(200, { transaction: { id: Number(order.id), status: order.state, items } });
    }
    const status = url.searchParams.get('status') ?? 'all';
    const sold = this.orders.filter(
      (order) =>
        url.searchParams.get('type') === 'sold' && (status === 'all' || order.state === status),
    );
    const { shown, pagination } = paged(sold);
    return json(200, {
      my_orders: shown.map((order) => ({
        transaction_id: Number(order.id),
        title: order.title,
        date: order.paidAt.toISOString(),
        price: { amount: amount(order.priceCents), currency_code: 'USD' },
        status: order.statusText ?? orderWords(order),
      })),
      pagination,
    });
  }

  /** The inbox and one conversation, as the web API answers them (M7). Only GETs. */
  #conversationApi(url: URL, member: Member): Reply {
    const fault = this.#takeFault('offers');
    if (fault !== null) {
      const reply = apiFaultReply(fault);
      if (reply !== null) return reply;
    }
    const conversations = this.#conversations(member);
    if (url.pathname === '/api/v2/inbox') {
      const ids = [...this.#chatIds(), ...conversations.map((one) => one.id)];
      const size = Math.max(1, Number(url.searchParams.get('per_page') ?? '20') || 20);
      return json(200, {
        conversations: ids.slice(0, size).map((id) => ({ id: Number(id), unread: false })),
        pagination: { current_page: 1, total_pages: Math.max(1, Math.ceil(ids.length / size)) },
      });
    }
    const id = /^\/api\/v2\/conversations\/(\d+)$/.exec(url.pathname)?.[1];
    if (id !== undefined && this.#chatIds().includes(id)) {
      return json(200, {
        conversation: {
          id: Number(id),
          opposite_user: { id: 1, login: 'asking-member' },
          transaction: null,
          messages: [{ entity_type: 'message', entity: { body: 'Is this still available?' } }],
        },
      });
    }
    const found = conversations.find((one) => one.id === id);
    return found === undefined
      ? json(404, { code: 404, message: 'Not found' })
      : json(200, conversationJson(found, member.id, this.offerStatusOverride));
  }

  /** A conversation's page, its offer's answer, and its message box; `null` for other paths. */
  async #conversationPages(
    request: IncomingMessage,
    url: URL,
    method: string,
    member: Member,
  ): Promise<Reply | null> {
    const match = /^\/inbox\/(\d+)(?:\/(offer|messages))?$/.exec(url.pathname);
    if (match === null) return null;
    const [, id = '', verb] = match;
    const conversation = this.#conversations(member).find((one) => one.id === id);
    if (conversation === undefined) {
      return {
        status: 404,
        body: page(
          'Page not found | Vinted',
          '<p data-testid="conversation-not-found">This conversation is no longer available.</p>',
        ),
      };
    }
    const show = (error: string | null, status = 200, redesigned = false): Reply => ({
      status,
      body: page(
        `${conversation.offer.buyer} | Vinted`,
        `${header(member, 'shown')}${conversationPage(
          conversation,
          error === null ? url.searchParams.get('confirm') : null,
          error,
          redesigned,
        )}`,
      ),
    });
    if (verb === undefined) {
      if (method !== 'GET') return notFound();
      const fault = this.#takeFault('conversation_page');
      const token = cookieValue(request.headers.cookie, SESSION_COOKIE) ?? '';
      const reply = fault === null ? null : this.#faultReply(fault, token, url.pathname, member);
      if (reply !== null) return reply;
      return show(null, 200, fault?.type === 'redesigned');
    }
    if (method !== 'POST') return notFound();
    const form = new URLSearchParams(await readBody(request));
    if (verb === 'messages') {
      this.messages.push({ conversationId: id, body: form.get('body') ?? '' });
      return { status: 303, headers: { location: `/inbox/${id}` } };
    }
    const action = form.get('action') ?? '';
    const counter = form.get('price');
    const { offer } = conversation;
    // Vinted takes no offer more than 40% below the listing's price, a counteroffer included.
    const floor = Math.ceil((offer.listPriceCents * 60) / 100);
    const cents = priceCents(counter ?? '');
    if (action === 'counter' && cents !== null && cents < floor) {
      return show(`Offers can't be lower than $${(floor / 100).toFixed(2)}.`, 422);
    }
    const answered = this.offers.answer(offer.id, action, counter);
    if (answered.status === 303) return { status: 303, headers: { location: `/inbox/${id}` } };
    if (answered.status === 500) {
      return { status: 500, body: page('Error | Vinted', '<h1>Something went wrong</h1>') };
    }
    return show(answered.message, answered.status);
  }

  /** An item as the web API shows it; the wardrobe's records carry no description. */
  #itemJson(item: FakeVintedItem, full: boolean): Record<string, unknown> {
    return {
      id: Number(item.id),
      title: item.title,
      ...(full ? { description: item.description } : {}),
      price: { amount: amount(item.priceCents), currency_code: 'USD' },
      is_closed: item.state === 'sold',
      is_hidden: item.state === 'hidden',
      is_reserved: item.state === 'reserved',
      is_draft: item.state === 'draft',
      is_processing: item.inReview === true,
      is_visible: item.state !== 'hidden' && item.inReview !== true,
      brand_title: item.brand ?? '',
      size_title: item.size ?? '',
      status: item.condition ?? '',
      ...(item.catalogId === null ? {} : { catalog_id: item.catalogId }),
      ...(full ? { color1: item.colors[0] ?? null, color2: item.colors[1] ?? null } : {}),
      photos: item.photos.map((name, index) => ({
        id: index + 1,
        url: `${this.#url}/media/${name}-thumb.jpg`,
        full_size_url: `${this.#url}/media/${name}.jpg`,
      })),
      path: `/items/${item.id}`,
    };
  }

  /** The reply a fault stands for, or `null` for a fault drawn in the page itself. */
  #faultReply(fault: FakeVintedFault, token: string, path: string, member: Member): Reply | null {
    switch (fault.type) {
      case 'datadome':
        return {
          status: 403,
          body: page(
            'vinted.com',
            `${header(member, 'shown')}<div id="ddChallengeContainer"><p>Please complete the check.</p></div>`,
          ),
        };
      case 'login_challenge':
        return { status: 302, headers: { location: '/member/verification' } };
      case 'session_expired':
        this.#sessions.delete(token);
        return redirectToLogin(path);
      case 'rate_limited':
        return {
          status: 429,
          ...(fault.retryAfterSeconds === undefined
            ? {}
            : { headers: { 'retry-after': String(fault.retryAfterSeconds) } }),
          body: page('Too many requests | Vinted', '<h1>Too many requests</h1>'),
        };
      case 'server_error':
        return { status: 500, body: page('Error | Vinted', '<h1>Something went wrong</h1>') };
      case 'account_verification':
        return {
          status: 302,
          headers: { location: `/users/verification?ref_url=${encodeURIComponent(path)}` },
        };
      case 'captcha':
      case 'redesigned':
      case 'no_login':
      case 'datadome_api':
      case 'unknown_shape':
      case 'verification_required':
      case 'reject':
      case 'slow':
      case 'stale_read':
        return null;
    }
  }

  // Listing pages ---------------------------------------------------------------------------

  /** The upload and edit forms, a listing's page, and its Hide and Unhide; `null` for others. */
  async #listingPages(
    request: IncomingMessage,
    url: URL,
    method: string,
    member: Member,
  ): Promise<Reply | null> {
    const token = cookieValue(request.headers.cookie, SESSION_COOKIE) ?? '';
    const path = url.pathname;
    if (path === VINTED_PATHS.upload) {
      if (method !== 'POST') {
        const fault = this.#takeFault('upload_page');
        const reply = fault === null ? null : this.#faultReply(fault, token, path, member);
        if (reply !== null) return reply;
        return this.#formPage('Sell an item | Vinted', path, EMPTY_FORM, false, [], fault);
      }
      return this.#upload(await readForm(request), token, path, member);
    }
    const action = /^\/items\/(\d+)\/(edit|hide|unhide)$/.exec(path);
    if (action !== null) {
      const [, id = '', verb] = action;
      const found = this.items.find((one) => one.id === id);
      if (found === undefined || found.state === 'draft') return notFound();
      if (verb === 'edit') {
        if (method === 'POST')
          return this.#save(found, await readForm(request), token, path, member);
        // Vinted shows no form for a listing that sold, or one it is reviewing.
        if (found.state === 'sold' || found.inReview === true) {
          return {
            status: 200,
            body: page(`${found.title} | Vinted`, itemPage(itemView(found, false))),
          };
        }
        return this.#formPage(
          `Edit ${found.title} | Vinted`,
          path,
          formValues(found),
          true,
          [],
          null,
        );
      }
      if (method !== 'POST') return notFound();
      return this.#toggle(found, verb === 'hide' ? 'end' : 'relist', token, path, member);
    }
    const shown = itemIdFromPath(path);
    if (shown !== null) {
      const found = this.items.find((one) => one.id === shown);
      if (found === undefined || found.state === 'draft') return notFound();
      const fault = this.#takeFault('item_page');
      const reply = fault === null ? null : this.#faultReply(fault, token, path, member);
      if (reply !== null) return reply;
      return {
        status: 200,
        body: page(
          `${found.title} | Vinted`,
          itemPage(itemView(found, fault?.type === 'redesigned')),
        ),
      };
    }
    return null;
  }

  #formPage(
    title: string,
    action: string,
    values: FormValues,
    editing: boolean,
    errors: readonly { field: string; message: string }[],
    fault: FakeVintedFault | null,
  ): Reply {
    // A redesigned form: no category field where Vinted's is.
    if (fault?.type === 'redesigned') {
      return { status: 200, body: page(title, '<main><h1>Sell an item</h1><form></form></main>') };
    }
    return { status: 200, body: page(title, uploadForm({ action, values, editing, errors })) };
  }

  /** Upload: checks the form as Vinted would, then posts the listing and opens its page. */
  async #upload(form: SubmittedForm, token: string, path: string, member: Member): Promise<Reply> {
    const values = submittedValues(form);
    const fault = this.#takeFault('create');
    const early = await this.#writeFault(fault, token, path, member, values, false);
    if (early !== null) return early;
    const errors = uploadErrors(values, form.files('photos').length);
    if (errors.length > 0)
      return this.#formPage('Sell an item | Vinted', path, values, false, errors, null);
    this.#nextItem += 1;
    const id = String(this.#nextItem);
    const category = FAKE_VINTED_CATEGORIES.find(
      (one) => one.path.join(' > ') === values.category?.join(' > '),
    );
    this.items.unshift({
      id,
      title: values.title,
      description: values.description,
      priceCents: priceCents(values.price) ?? 0,
      state: 'active',
      brand: values.brand === 'No brand' ? null : values.brand,
      size: values.size,
      condition: values.condition,
      catalogId: null,
      colors: [...values.colors],
      photos: form
        .files('photos')
        .map((name, index) => `${fakeMediaName(name)}-${id}-${String(index)}`),
      ...(category === undefined ? {} : { category: [...category.path] }),
      ...(values.packageSize === null ? {} : { packageSize: values.packageSize }),
      inReview: this.reviewUploads,
    });
    return this.#afterWrite(fault, `/items/${id}-${slug(values.title)}`);
  }

  /** Save on the edit form: the price, title, and description it shows. */
  async #save(
    item: FakeVintedItem,
    form: SubmittedForm,
    token: string,
    path: string,
    member: Member,
  ): Promise<Reply> {
    const values = submittedValues(form);
    const fault = this.#takeFault('update');
    const early = await this.#writeFault(fault, token, path, member, values, true);
    if (early !== null) return early;
    const cents = priceCents(values.price);
    if (cents === null || cents < 100) {
      return this.#formPage(
        `Edit ${item.title} | Vinted`,
        path,
        values,
        true,
        [{ field: 'price', message: 'Enter a price of at least $1.00.' }],
        null,
      );
    }
    this.#previous.set(item.id, { ...item, colors: [...item.colors], photos: [...item.photos] });
    item.priceCents = cents;
    if (values.title !== '') item.title = values.title;
    if (values.description !== '') item.description = values.description;
    return this.#afterWrite(fault, `/items/${item.id}-${slug(item.title)}`);
  }

  /** Hide or Unhide; Vinted refuses either while it reviews the listing, and once it sold. */
  async #toggle(
    item: FakeVintedItem,
    action: 'end' | 'relist',
    token: string,
    path: string,
    member: Member,
  ): Promise<Reply> {
    const fault = this.#takeFault(action);
    const early = await this.#writeFault(fault, token, path, member, null, true);
    if (early !== null) return early;
    if (item.inReview !== true && item.state !== 'sold') {
      this.#previous.set(item.id, { ...item, colors: [...item.colors], photos: [...item.photos] });
      item.state = action === 'end' ? 'hidden' : 'active';
    }
    return this.#afterWrite(fault, `/items/${item.id}-${slug(item.title)}`);
  }

  /**
   * A write's fault before the change: its reply, or `null` to go on with the change (a fault
   * that comes after it, or none). `values` redraws the form under a refusal.
   */
  async #writeFault(
    fault: FakeVintedFault | null,
    token: string,
    path: string,
    member: Member,
    values: FormValues | null,
    editing: boolean,
  ): Promise<Reply | null> {
    if (fault === null) return null;
    switch (fault.type) {
      case 'reject':
        return this.#formPage(
          'Sell an item | Vinted',
          path,
          values ?? EMPTY_FORM,
          editing,
          [{ field: 'title', message: fault.message }],
          null,
        );
      case 'server_error':
        return fault.afterApply === true ? null : this.#faultReply(fault, token, path, member);
      case 'slow':
        if (fault.afterApply) return null;
        await sleep(fault.delayMs);
        return null;
      case 'stale_read':
        return null;
      case 'datadome':
      case 'captcha':
      case 'login_challenge':
      case 'session_expired':
      case 'rate_limited':
      case 'redesigned':
      case 'no_login':
      case 'datadome_api':
      case 'unknown_shape':
      case 'verification_required':
      case 'account_verification':
        return this.#faultReply(fault, token, path, member);
    }
  }

  /** The answer once the change is made: a fault that comes after it, or the listing's page. */
  async #afterWrite(fault: FakeVintedFault | null, location: string): Promise<Reply> {
    if (fault?.type === 'server_error' && fault.afterApply === true) {
      return { status: 500, body: page('Error | Vinted', '<h1>Something went wrong</h1>') };
    }
    if (fault?.type === 'slow' && fault.afterApply) await sleep(fault.delayMs);
    return { status: 303, headers: { location } };
  }
}

/** What the fake's listing page shows of an item. */
function itemView(item: FakeVintedItem, redesigned: boolean): Parameters<typeof itemPage>[0] {
  return {
    id: item.id,
    title: item.title,
    state: item.state,
    inReview: item.inReview === true,
    redesigned,
  };
}

/** An item as its edit form shows it. */
function formValues(item: FakeVintedItem): FormValues {
  return {
    title: item.title,
    description: item.description,
    category: item.category ?? null,
    brand: item.brand,
    size: item.size,
    condition: item.condition,
    colors: item.colors,
    packageSize: item.packageSize ?? null,
    price: amount(item.priceCents),
  };
}

function submittedValues(form: SubmittedForm): FormValues {
  const category = form.text('category');
  const packageSize = form.text('package_size');
  const colors = form.text('colors');
  return {
    title: form.text('title'),
    description: form.text('description'),
    category: category === '' ? null : category.split(' > '),
    brand: form.text('brand') || null,
    size: form.text('size') || null,
    condition: form.text('condition') || null,
    colors: colors === '' ? [] : colors.split(','),
    packageSize:
      packageSize === 'small' || packageSize === 'medium' || packageSize === 'large'
        ? packageSize
        : null,
    price: form.text('price'),
  };
}

/** What Vinted's upload form refuses, under each field. */
function uploadErrors(values: FormValues, photos: number): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  if (photos === 0) errors.push({ field: 'photos', message: 'Add at least 1 photo.' });
  if (photos > 20) errors.push({ field: 'photos', message: 'You can add up to 20 photos.' });
  if (values.title.trim().length < 3) errors.push({ field: 'title', message: 'Enter a title.' });
  if (values.description.trim() === '') {
    errors.push({ field: 'description', message: 'Describe your item.' });
  }
  const category = FAKE_VINTED_CATEGORIES.find(
    (one) => one.path.join(' > ') === values.category?.join(' > '),
  );
  if (category === undefined) {
    errors.push({ field: 'catalog', message: 'Select a category.' });
    return errors;
  }
  if (category.brand && values.brand === null) {
    errors.push({ field: 'brand', message: 'Select a brand.' });
  }
  if (
    category.sizes.length > 0 &&
    (values.size === null || !category.sizes.includes(values.size))
  ) {
    errors.push({ field: 'size', message: 'Select a size.' });
  }
  if (values.condition === null) errors.push({ field: 'status', message: 'Select a condition.' });
  if (values.packageSize === null) {
    errors.push({ field: 'package_size', message: 'Select a package size.' });
  }
  const cents = priceCents(values.price);
  if (cents === null || cents < 100) {
    errors.push({ field: 'price', message: 'Enter a price of at least $1.00.' });
  }
  return errors;
}

/** Cents from the price field (`45`, `12.50`); `null` for anything else. */
function priceCents(price: string): number | null {
  const match = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(price.trim());
  if (match?.[1] === undefined) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'item'
  );
}

function notFound(): Reply {
  return { status: 404, body: page('Page not found | Vinted', '<h1>Page not found</h1>') };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SubmittedForm {
  text(name: string): string;
  /** The names of the non-empty files sent in `name`, in order. */
  files(name: string): string[];
}

/** A posted form, URL-encoded or multipart (with its photos' file names). */
async function readForm(request: IncomingMessage): Promise<SubmittedForm> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 8_000_000) throw new Error('form too large');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const type = request.headers['content-type'] ?? '';
  const boundary = /^multipart\/form-data;.*boundary=("?)([^";]+)\1/i.exec(type)?.[2];
  const fields = new Map<string, string>();
  const files = new Map<string, string[]>();
  if (boundary === undefined) {
    for (const [name, value] of new URLSearchParams(body.toString('utf8'))) fields.set(name, value);
  } else {
    const delimiter = Buffer.from(`--${boundary}`);
    let start = body.indexOf(delimiter);
    while (start !== -1) {
      const next = body.indexOf(delimiter, start + delimiter.length);
      if (next === -1) break;
      const part = body.subarray(start + delimiter.length + 2, next - 2);
      const split = part.indexOf('\r\n\r\n');
      if (split !== -1) {
        const headers = part.subarray(0, split).toString('utf8');
        const content = part.subarray(split + 4);
        const name = /name="([^"]*)"/.exec(headers)?.[1];
        const filename = /filename="([^"]*)"/.exec(headers)?.[1];
        if (name !== undefined) {
          if (filename !== undefined) {
            if (content.length > 0) files.set(name, [...(files.get(name) ?? []), filename]);
          } else {
            fields.set(name, content.toString('utf8'));
          }
        }
      }
      start = next;
    }
  }
  return {
    text: (name) => fields.get(name)?.replaceAll('\r\n', '\n').trim() ?? '',
    files: (name) => files.get(name) ?? [],
  };
}

/** The web API's answer a fault stands for, or `null` for one that is not the API's. */
function apiFaultReply(fault: FakeVintedFault): Reply | null {
  switch (fault.type) {
    case 'datadome_api':
      return json(403, { url: 'https://geo.captcha-delivery.com/captcha/?initialCid=fake' });
    case 'unknown_shape':
      return json(200, { data: { entries: [] } });
    case 'verification_required':
      return json(400, {
        code: 115,
        message: 'Member verification required',
        message_code: 'user_verification_required',
        payload: {},
      });
    case 'rate_limited':
      return {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(fault.retryAfterSeconds ?? 30),
        },
        body: JSON.stringify({ code: 429, message: 'Too many requests' }),
      };
    case 'server_error':
      return json(500, { code: 500, message: 'Something went wrong' });
    case 'session_expired':
      return json(401, { code: 100, message: 'Unauthorized' });
    case 'datadome':
    case 'captcha':
    case 'login_challenge':
    case 'redesigned':
    case 'no_login':
    case 'reject':
    case 'slow':
    case 'stale_read':
    case 'account_verification':
      return null;
  }
}

function json(status: number, body: unknown): Reply {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** Cents as Vinted's amounts show them: `"18.0"`, `"18.5"`, `"18.25"`. */
function amount(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0
    ? `${String(dollars)}.0`
    : `${String(dollars)}.${String(rest).padStart(2, '0').replace(/0$/, '')}`;
}

function redirectToLogin(path: string): Reply {
  return {
    status: 302,
    headers: { location: `${VINTED_LOGIN_PATH}?ref_url=${encodeURIComponent(path)}` },
  };
}

/**
 * The page header as Vinted draws it for a member: the user menu's button, and the menu with the
 * member's profile link (`/member/<id>`, no login), which Vinted draws once the button is pressed
 * (here it is drawn hidden). `none`: no user menu, as after a site redesign.
 */
function header(member: Member, menu: 'shown' | 'none'): string {
  const userMenu =
    menu === 'none'
      ? '<nav data-testid="account-nav"><span>Menu</span></nav>'
      : `<button type="button" data-testid="user-menu-button" aria-label="Menu"></button><div hidden><a href="/member/${member.id}">Profile</a><a href="/settings/profile">Settings</a></div>`;
  return `<header><a href="/">Vinted</a>${userMenu}</header>`;
}

function loginForm(): string {
  return `<form method="post" action="${VINTED_LOGIN_PATH}"><label>Email or username <input name="login" id="login"></label><label>Password <input type="password" name="password" id="password"></label><button type="submit">Continue</button></form>`;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body>${body}</body></html>`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 16_384) throw new Error('form too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}
