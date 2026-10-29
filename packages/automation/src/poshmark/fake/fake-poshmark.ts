/**
 * The fake Poshmark: a local web app that mirrors the Poshmark pages and flows the Poshmark
 * automation adapter uses, for its tests and for development (`npm run dev:fake-poshmark`). No
 * test ever sends traffic to the real Poshmark.
 *
 * It mirrors what Listora read on Poshmark's public pages (2026-10-24): listing and closet pages
 * that embed their data as `window.__INITIAL_STATE__` in a script that removes itself once it
 * ran, with Poshmark's own keys (listing records with `inventory.status`, `price_amount.val`, and
 * change times to the second), 24-hex listing ids, closet filters and pages (`availability`,
 * `sort_by`, `max_id`), and seller pages that send a browser without a session to
 * `/login?pmrd[url]=...`. The listing editor, behind Poshmark's login, mirrors exactly what the
 * adapter's form module reads (poshmark/pages/listing-form.ts, mapped on a real seller's session
 * 2026-10-26), with Poshmark's form rules: the cover-photo editor whose Apply keeps the photos,
 * the dropdown pickers, the Listing Price dialog with Automate Offers, the SKU in the private
 * details, and a new listing's Next and then List, after which Poshmark shows the seller's closet
 * (which doesn't name the new listing; its form named the listing's id from the moment it opened,
 * in its photos section's `data-et-prop-listing_id`). The edit form's data holds the listing's
 * private SKU, and a listing off the site answers 404 with Poshmark's record of what became of it:
 * `archived` once its seller deleted it (`remove`), `hidden` once Poshmark hid it (`hide`). It
 * injects every failure the adapter must stop at or recover from.
 *
 *   GET  /login                      the login page (a password field: no Listora session needs it)
 *   POST /login                      log in by hand: any username and password; sets the session cookie
 *   GET  /create-listing             the listing form (a session is required)
 *   POST /create-listing             list (the share step's List); answers with the seller's closet
 *   GET  /listing/<title>-<id>       a listing's public page (also /listing/<id>); 404 once deleted
 *   GET  /edit-listing/<id>          its edit form (its seller's session only)
 *   POST /edit-listing/<id>          update it
 *   POST /share-listing/<id>         share it to the seller's followers (the listing page's Share,
 *                                    then To My Followers); it moves the listing's `updated_at`
 *   GET  /closet/<username>          a closet: ?availability=all|available|sold_out|not_for_sale,
 *                                    &sort_by=added_desc, &query=, &max_id=
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SessionCookie } from '@listora/connections';

import {
  cookieValue,
  delay,
  escape,
  readForm,
  type Reply,
  type SubmittedForm,
} from '../../fake-site/http.ts';
import {
  POSHMARK_COLORS,
  POSHMARK_DEPARTMENTS,
  poshmarkCatalog,
  poshmarkCategories,
  sizeSetsFor,
  subcategoriesOf,
  type PoshmarkDepartment,
} from '../catalog.ts';
import { FakeOfferDesk, fakeOfferPageBody } from '../../fake-offers/fake-offers.ts';
import { FAKE_MEDIA_PATH, fakeMediaName, fakeMediaPhoto } from '../../fake-photos/fake-photos.ts';
import { MAX_POSHMARK_COLORS } from '../colors.ts';
import { POSHMARK_CONDITIONS, type PoshmarkConditionCode } from '../conditions.ts';
import { POSHMARK_LIMITS } from '../payload.ts';

export type FakePoshmarkAction =
  /** GET /create-listing */
  | 'new_form'
  /** POST /create-listing */
  | 'create'
  /** GET /edit-listing/<id> */
  | 'edit_form'
  /** POST /edit-listing/<id> */
  | 'update'
  /** GET /listing/<id> */
  | 'listing'
  /** GET /closet/<username> */
  | 'closet'
  /** POST /share-listing/<id> */
  | 'share'
  /** GET /offers/my_offers */
  | 'offers'
  /** GET /offers/<id> */
  | 'offer'
  /** POST /offers/<id>/answer */
  | 'answer_offer';

export type FakePoshmarkFault =
  /** A visible CAPTCHA widget instead of the page. */
  | { type: 'captcha' }
  /** A bot-check interstitial ("Just a moment..."), status 403. */
  | { type: 'bot_check' }
  /** A one-time code step ("Enter the 6-digit code we sent you"). */
  | { type: 'login_challenge' }
  /** The session is invalidated; seller pages send the browser to the login page. */
  | { type: 'session_expired' }
  | { type: 'rate_limited'; retryAfterSeconds?: number }
  /** A 500 page; with `afterApply`, the change was made first. */
  | { type: 'server_error'; afterApply?: boolean }
  /** The form comes back with Poshmark's validation message; nothing is applied. */
  | { type: 'reject'; message: string }
  /** The answer comes after `delayMs`; with `afterApply`, the change is made at once. */
  | { type: 'slow'; delayMs: number; afterApply: boolean }
  /** A listing page shows the listing as it was before its latest change. */
  | { type: 'stale_read' }
  /**
   * A listing page shows no listing, and no word of what became of it, as Poshmark's did for a
   * listing just listed or changed (for about two minutes, 2026-10-27).
   */
  | { type: 'not_shown_yet' }
  /** A redesigned page: none of the data or the form the adapter knows. */
  | { type: 'redesign' }
  /** A redirect to another origin (the same server under `localhost`). */
  | { type: 'offsite' };

export interface FakePoshmarkFaultRule {
  action: FakePoshmarkAction;
  fault: FakePoshmarkFault;
  /** How many matching requests get it (default 1). */
  times?: number;
}

export type FakeInventoryStatus = 'available' | 'not_for_sale' | 'sold_out';

export interface FakePoshmarkListing {
  id: string;
  /** The seller's username. */
  seller: string;
  /** The seller's private SKU (only the edit form shows it). */
  sku: string;
  title: string;
  description: string;
  priceCents: number;
  originalPriceCents: number | null;
  brand: string;
  department: PoshmarkDepartment;
  category: string;
  subcategory: string | null;
  sizeSet: string;
  size: string;
  condition: PoshmarkConditionCode;
  /** Poshmark's names of the listing's colors (up to two). */
  colors: string[];
  /** The byte sizes of the listing's photos in posting order (the first is the cover). */
  photoSizes: number[];
  inventory: FakeInventoryStatus;
  /**
   * Whether Poshmark is reviewing it after a change (`status: "for_review"`): its seller sees it
   * and can change it, buyers can't buy it (read on the captain's listings, 2026-10-27).
   */
  reviewing: boolean;
  createdAt: Date;
  updatedAt: Date;
  inventoryChangedAt: Date;
}

export interface FakePoshmarkRequest {
  method: string;
  path: string;
  action: FakePoshmarkAction | null;
  userAgent: string;
  at: number;
  fault: FakePoshmarkFault['type'] | null;
  status: number;
}

export interface FakePoshmarkOptions {
  /** Listings per closet page (Poshmark shows 48). */
  pageSize?: number;
  /** Rotate the session cookie every this many requests of a session (default: never). */
  rotateSessionEvery?: number;
}

export type FakePoshmarkSeed = Partial<Omit<FakePoshmarkListing, 'id'>> &
  Pick<FakePoshmarkListing, 'title' | 'priceCents'>;

interface StoredListing {
  current: FakePoshmarkListing;
  previous: FakePoshmarkListing | null;
}

interface Session {
  seller: string;
  requests: number;
}

const SESSION_COOKIE = '_web_session';
const DEFAULT_SELLER = 'listora_closet';

export class FakePoshmark {
  readonly #server: Server;
  readonly #options: FakePoshmarkOptions;
  #reviewChanges = false;
  readonly #listings = new Map<string, StoredListing>();
  /** The ids new listings' forms named, each the id of the listing its form lists. */
  readonly #drafts = new Set<string>();
  /** Listings no longer on the site, with what became of each, as their 404 pages say. */
  readonly #gone = new Map<string, 'archived' | 'hidden'>();
  readonly #sessions = new Map<string, Session>();
  readonly #faults: (FakePoshmarkFaultRule & { remaining: number })[] = [];
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly requests: FakePoshmarkRequest[] = [];
  /** Buyers' offers on the seller's listings, and the answers the fake took. */
  readonly offers = new FakeOfferDesk();
  /** The newest change time, to the second: every change gets a later second (see `#tick`). */
  #clock = 0;
  #url = '';

  private constructor(options: FakePoshmarkOptions) {
    this.#options = options;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end(error instanceof Error ? error.message : 'error');
        }
      });
    });
  }

  static async start(port = 0, options: FakePoshmarkOptions = {}): Promise<FakePoshmark> {
    const site = new FakePoshmark(options);
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

  /** The cookie a seller's logged-in browser holds, as the app would hand it to Listora. */
  issueSession(seller = DEFAULT_SELLER): SessionCookie {
    const token = randomBytes(16).toString('hex');
    this.#sessions.set(token, { seller, requests: 0 });
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

  sessionValid(token: string): boolean {
    return this.#sessions.has(token);
  }

  inject(rule: FakePoshmarkFaultRule): void {
    this.#faults.push({ ...rule, remaining: rule.times ?? 1 });
  }

  clearFaults(): void {
    this.#faults.length = 0;
  }

  /** The listings, optionally only those with this private SKU. */
  listings(sku?: string): FakePoshmarkListing[] {
    return [...this.#listings.values()]
      .map((stored) => ({ ...stored.current }))
      .filter((listing) => sku === undefined || listing.sku === sku);
  }

  listing(id: string): FakePoshmarkListing | undefined {
    const stored = this.#listings.get(id);
    return stored === undefined ? undefined : { ...stored.current };
  }

  /**
   * From now on, whether each change puts the listing under Poshmark's review, as Poshmark did
   * with the captain's listings after every change (2026-10-27).
   */
  reviewChanges(on: boolean): void {
    this.#reviewChanges = on;
  }

  /** Poshmark finishes reviewing the listing: it is live again. */
  publish(id: string): void {
    const stored = this.#listings.get(id);
    if (stored === undefined) throw new Error(`no listing ${id}`);
    stored.current = { ...stored.current, reviewing: false };
  }

  /** Lists an item directly, as the seller once did by hand; returns its id. */
  seed(seed: FakePoshmarkSeed): string {
    const at = this.#tick();
    const listing: FakePoshmarkListing = {
      id: listingId(),
      seller: DEFAULT_SELLER,
      sku: '',
      description: 'Listed by hand.',
      originalPriceCents: null,
      brand: '',
      department: 'Women',
      category: 'Tops',
      subcategory: null,
      sizeSet: 'Standard',
      size: 'M',
      condition: 'ug',
      colors: [],
      photoSizes: [4],
      inventory: 'available',
      reviewing: false,
      createdAt: at,
      updatedAt: at,
      inventoryChangedAt: at,
      ...seed,
    };
    this.#listings.set(listing.id, { current: listing, previous: null });
    return listing.id;
  }

  /** A buyer buys the listing: it is sold out, and shows on the seller's sold items page. */
  sell(id: string): void {
    const stored = this.#listings.get(id);
    if (stored === undefined) throw new Error(`no listing ${id}`);
    const at = this.#tick();
    this.#change(stored, { inventory: 'sold_out', inventoryChangedAt: at });
  }

  /**
   * The seller deletes the listing: its pages answer 404 from then on, as Poshmark's do, and its
   * page's record says it is `archived`.
   */
  remove(id: string): void {
    if (!this.#listings.delete(id)) throw new Error(`no listing ${id}`);
    this.#gone.set(id, 'archived');
  }

  /**
   * Poshmark hides the listing, as it does with one it removed under its rules: its pages answer
   * 404, and its page's record says it is `hidden`.
   */
  hide(id: string): void {
    if (!this.#listings.delete(id)) throw new Error(`no listing ${id}`);
    this.#gone.set(id, 'hidden');
  }

  async close(): Promise<void> {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
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
    const record: FakePoshmarkRequest = {
      method,
      path: url.pathname,
      action: null,
      userAgent: request.headers['user-agent'] ?? '',
      at: Date.now(),
      fault: null,
      status: 0,
    };
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

    if (url.pathname === '/login') {
      if (method === 'POST') {
        // The seller logs in by hand, as on the app's Link accounts screen in development: any
        // username with a password starts a session as that seller.
        const form = await readForm(request);
        const seller = form.text('login_form[username_email]');
        if (seller !== '' && form.text('login_form[password]') !== '') {
          const { value } = this.issueSession(seller);
          send({
            status: 303,
            headers: {
              location: `/closet/${encodeURIComponent(seller)}`,
              'set-cookie': `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
            },
          });
          return;
        }
      }
      send({ status: 200, body: page('Login - Poshmark', loginForm(), null) });
      return;
    }
    if (url.pathname === '/elsewhere') {
      send({ status: 200, body: page('Elsewhere', '<p>Not Poshmark.</p>', null) });
      return;
    }
    const media = FAKE_MEDIA_PATH.exec(url.pathname)?.[1];
    if (media !== undefined) {
      record.status = 200;
      void fakeMediaPhoto(media).then((photo) => {
        response.writeHead(200, { 'content-type': 'image/jpeg' });
        response.end(photo);
      });
      return;
    }

    const route = matchRoute(method, url.pathname);
    record.action = route?.action ?? null;
    const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
    let session = token === undefined ? undefined : this.#sessions.get(token);
    const headers: Record<string, string> = {};
    if (session !== undefined && token !== undefined) {
      session.requests += 1;
      const every = this.#options.rotateSessionEvery;
      if (every !== undefined && session.requests % every === 0) {
        // A refreshed session cookie; the old one stops working at once.
        const next = randomBytes(16).toString('hex');
        this.#sessions.delete(token);
        this.#sessions.set(next, session);
        headers['set-cookie'] =
          `${SESSION_COOKIE}=${next}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
      }
    }
    if (route === null) {
      send({ status: 404, headers, body: notFound(session?.seller ?? null) });
      return;
    }

    const fault = this.#takeFault(route.action);
    record.fault = fault?.type ?? null;
    if (fault?.type === 'session_expired') {
      if (token !== undefined) this.#sessions.delete(token);
      session = undefined;
    }
    if (route.private && session === undefined) {
      const redirect = loginRedirect(url);
      send({ ...redirect, headers: { ...headers, ...redirect.headers } });
      return;
    }
    const reply = await this.#route(route, url, request, session ?? null, fault);
    send({ ...reply, headers: { ...headers, ...reply.headers } });
  }

  async #route(
    route: Route,
    url: URL,
    request: IncomingMessage,
    session: Session | null,
    fault: FakePoshmarkFault | undefined,
  ): Promise<Reply> {
    const seller = session?.seller ?? null;
    switch (fault?.type) {
      case 'captcha':
        return { status: 200, body: page('Poshmark', captchaModal(), seller) };
      case 'bot_check':
        return {
          status: 403,
          body: page('Just a moment...', '<p>Checking your browser.</p>', null),
        };
      case 'login_challenge':
        return { status: 200, body: page('Poshmark', otpModal(), seller) };
      case 'rate_limited':
        return {
          status: 429,
          headers:
            fault.retryAfterSeconds === undefined
              ? {}
              : { 'retry-after': String(fault.retryAfterSeconds) },
          body: page('Poshmark', '<p>Too many requests.</p>', null),
        };
      case 'redesign':
        return {
          status: 200,
          body: '<!doctype html><html><head><title>Poshmark</title></head><body><main>A new look.</main></body></html>',
        };
      case 'offsite':
        return {
          status: 302,
          headers: { location: `${this.#url.replace('127.0.0.1', 'localhost')}/elsewhere` },
        };
      case 'session_expired':
      case 'server_error':
      case 'reject':
      case 'slow':
      case 'stale_read':
      case 'not_shown_yet':
      case undefined:
        break;
    }
    const form = route.method === 'POST' ? await readForm(request) : null;
    if (fault?.type === 'reject' && form !== null) {
      return { status: 422, body: this.#formPage(route, seller, [fault.message]) };
    }
    const apply = (): Reply => this.#apply(route, url, form, seller, fault);
    if (fault?.type === 'server_error') {
      if (fault.afterApply === true) apply();
      return { status: 500, body: page('Poshmark', '<p>Something went wrong.</p>', null) };
    }
    if (fault?.type === 'slow') {
      const early = fault.afterApply ? apply() : undefined;
      await delay(fault.delayMs, this.#timers);
      return early ?? apply();
    }
    return apply();
  }

  #apply(
    route: Route,
    url: URL,
    form: SubmittedForm | null,
    seller: string | null,
    fault: FakePoshmarkFault | undefined,
  ): Reply {
    switch (route.action) {
      case 'new_form': {
        // As on Poshmark: the form gets the id of the listing it makes when it opens.
        const draft = listingId();
        this.#drafts.add(draft);
        return { status: 200, body: this.#formPage(route, seller, [], undefined, draft) };
      }
      case 'edit_form': {
        const stored = this.#own(route.id, seller);
        if (stored === undefined) return { status: 404, body: notFound(seller) };
        return { status: 200, body: this.#formPage(route, seller, []) };
      }
      case 'create': {
        if (seller === null || form === null) return { status: 400, body: notFound(seller) };
        const fields = formFields(form);
        const draft = form.text('listing_id');
        const problems = invalidListing(fields, form.files('photos').length, true);
        if (problems.length > 0) {
          return { status: 422, body: this.#formPage(route, seller, problems, fields, draft) };
        }
        const at = this.#tick();
        const listing: FakePoshmarkListing = {
          id: this.#drafts.delete(draft) ? draft : listingId(),
          seller,
          ...completeFields(fields),
          photoSizes: form.files('photos'),
          inventory: fields.availability === 'not_for_sale' ? 'not_for_sale' : 'available',
          reviewing: false,
          createdAt: at,
          updatedAt: at,
          inventoryChangedAt: at,
        };
        this.#listings.set(listing.id, { current: listing, previous: null });
        // As on Poshmark: List ends on the seller's closet, whose address doesn't name the listing.
        return { status: 302, headers: { location: `/closet/${encodeURIComponent(seller)}` } };
      }
      case 'update': {
        const stored = this.#own(route.id, seller);
        if (stored === undefined || form === null) return { status: 404, body: notFound(seller) };
        const fields = formFields(form);
        const problems = invalidListing(fields, stored.current.photoSizes.length, false);
        if (problems.length > 0) {
          return { status: 422, body: this.#formPage(route, seller, problems, fields) };
        }
        // The SKU is fixed when the listing is created.
        const details: Partial<FakePoshmarkListing> = completeFields(fields);
        delete details.sku;
        const at = this.#tick();
        const inventory: FakeInventoryStatus =
          stored.current.inventory === 'sold_out'
            ? 'sold_out'
            : fields.availability === 'not_for_sale'
              ? 'not_for_sale'
              : 'available';
        this.#change(stored, {
          ...details,
          reviewing: this.#reviewChanges || stored.current.reviewing,
          updatedAt: at,
          ...(inventory === stored.current.inventory ? {} : { inventory, inventoryChangedAt: at }),
        });
        return { status: 302, headers: { location: listingPath(stored.current) } };
      }
      case 'listing': {
        const stored = route.id === null ? undefined : this.#listings.get(route.id);
        const gone = route.id === null ? undefined : this.#gone.get(route.id);
        if (stored === undefined && gone !== undefined && route.id !== null) {
          return { status: 404, body: removedPage(route.id, gone, seller) };
        }
        if (stored === undefined || fault?.type === 'not_shown_yet') {
          return { status: 404, body: notFound(seller) };
        }
        const shown =
          fault?.type === 'stale_read' && stored.previous !== null
            ? stored.previous
            : stored.current;
        return {
          status: 200,
          body: page(`${shown.title} | Poshmark`, listingBody(shown, seller), seller, {
            $_listing_details: { listingDetails: listingRecord(shown, this.url) },
          }),
        };
      }
      case 'closet':
        return this.#closet(route.id ?? '', url, seller);
      case 'share': {
        // As on Poshmark: only an available listing shares, and a share moves it to the top of
        // the seller's followers' feeds without changing it.
        const stored = this.#own(route.id, seller);
        if (stored === undefined) return { status: 404, body: notFound(seller) };
        if (stored.current.inventory !== 'available' || stored.current.reviewing) {
          return { status: 302, headers: { location: listingPath(stored.current) } };
        }
        this.#change(stored, { updatedAt: this.#tick() });
        return { status: 302, headers: { location: listingPath(stored.current) } };
      }
      case 'offers':
        return { status: 200, body: this.#offersPage(seller) };
      case 'offer': {
        const offer = this.offers.get(route.id ?? '');
        return {
          status: offer === undefined ? 404 : 200,
          body: page(
            'Offer - Poshmark',
            fakeOfferPageBody(offer, `/offers/${route.id ?? ''}`, url.searchParams.get('confirm')),
            seller,
          ),
        };
      }
      case 'answer_offer': {
        const id = route.id ?? '';
        const answered = this.offers.answer(
          id,
          form?.text('action') ?? '',
          form?.text('counter') ?? null,
        );
        if (answered.status === 303) return { status: 303, headers: { location: `/offers/${id}` } };
        return {
          status: answered.status,
          body: page(
            'Offer - Poshmark',
            fakeOfferPageBody(this.offers.get(id), `/offers/${id}`, null, answered.message),
            seller,
          ),
        };
      }
    }
  }

  /** Active Offers, as Poshmark embeds it: the buyers' offers on the seller's listings. */
  #offersPage(seller: string | null): string {
    const offers = this.offers.list();
    const empty = (subtitle: string) => ({
      type: 'info_message',
      data: [{ text: { title: 'No Active Offers', subtitle } }],
    });
    const story = (title: string, type: string, content: Record<string, unknown>) => ({
      header: { layout: 'TEXT_HEADER', title },
      story_type: type,
      content,
      footer: null,
    });
    const sale =
      offers.length === 0
        ? empty('Buyers can privately negotiate on your listings.')
        : {
            type: 'offer_summary_list',
            data: offers.map((offer) => ({
              offer_id: offer.id,
              post_id: offer.listingId,
              listing_title: offer.listingTitle,
              offer_amount: { val: (offer.amountCents / 100).toFixed(2), currency_code: 'USD' },
              listing_price: { val: (offer.listPriceCents / 100).toFixed(2), currency_code: 'USD' },
              ...(offer.shippingCents === null
                ? {}
                : {
                    shipping_price: {
                      val: (offer.shippingCents / 100).toFixed(2),
                      currency_code: 'USD',
                    },
                  }),
              buyer: { username: offer.buyer },
              waiting_on: offer.status === 'pending' ? 'seller' : 'buyer',
              created_at: offer.createdAt,
              expires_at: offer.expiresAt,
              offer_url: `/offers/${offer.id}`,
            })),
          };
    return page(
      'Active Offers - Poshmark',
      '<h1>Active Offers</h1><div data-test="active-offer-section"></div>',
      seller,
      {
        $_order_activity: {
          orderActivity: {
            activeOffers: [
              story(
                'FOR PURCHASE',
                'purchase_offer_summaries',
                empty('Offers allow you to negotiate.'),
              ),
              story('FOR SALE', 'sale_offer_summaries', sale),
            ],
            activeOffersMeta: {
              offers_pending_response_count: {
                waiting_on_seller: offers.filter((offer) => offer.status === 'pending').length,
                waiting_on_buyer: offers.filter((offer) => offer.status === 'countered').length,
              },
            },
          },
        },
      },
    );
  }

  #closet(username: string, url: URL, seller: string | null): Reply {
    const availability = url.searchParams.get('availability') ?? 'available';
    const query = (url.searchParams.get('query') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const newestFirst = url.searchParams.get('sort_by') === 'added_desc';
    const pageSize = this.#options.pageSize ?? 48;
    const offset = Number(url.searchParams.get('max_id') ?? '0');
    const all = [...this.#listings.values()]
      .map((stored) => stored.current)
      .filter((listing) => listing.seller === username)
      .filter((listing) => availability === 'all' || listing.inventory === availability)
      .filter((listing) => query.every((word) => listing.title.toLowerCase().includes(word)))
      .sort((a, b) =>
        newestFirst
          ? b.createdAt.getTime() - a.createdAt.getTime()
          : b.inventoryChangedAt.getTime() - a.inventoryChangedAt.getTime(),
      );
    const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const shown = all.slice(start, start + pageSize);
    const hasMore = start + pageSize < all.length;
    const tiles = shown
      .map(
        (listing) =>
          `<div class="tile"><a href="${listingPath(listing)}">${escape(listing.title)}</a></div>`,
      )
      .join('');
    return {
      status: 200,
      body: page(
        `${username}'s Closet | Poshmark`,
        `<main data-test="closet">${tiles}</main>`,
        seller,
        {
          $_closet: {
            closetUserInfo: { data: { username } },
            listingsPostData: {
              data: shown.map((listing) => listingRecord(listing, this.url)),
              more: {
                total: all.length,
                is_next_max_id_present: hasMore,
                ...(hasMore ? { next_max_id: String(start + pageSize) } : {}),
              },
            },
          },
        },
      ),
    };
  }

  #formPage(
    route: Route,
    seller: string | null,
    errors: readonly string[],
    submitted?: FormFields,
    draft?: string,
  ): string {
    const stored = route.id === null ? undefined : this.#listings.get(route.id);
    const values = submitted ?? (stored === undefined ? null : fieldsOf(stored.current));
    const editing = route.id !== null;
    return page(
      editing ? 'Edit Listing | Poshmark' : 'Sell on Poshmark',
      listingForm(
        editing ? `/edit-listing/${route.id ?? ''}` : '/create-listing',
        values,
        errors,
        editing,
        draft ?? null,
      ),
      seller,
      // The edit form's data holds the listing's private SKU (its field has no value attribute).
      stored === undefined
        ? {}
        : {
            $_listing_editor: {
              post: {
                id: stored.current.id,
                title: stored.current.title,
                seller_private_info: { sku: stored.current.sku },
              },
            },
          },
    );
  }

  #own(id: string | null, seller: string | null): StoredListing | undefined {
    const stored = id === null ? undefined : this.#listings.get(id);
    return stored?.current.seller === seller ? stored : undefined;
  }

  #change(stored: StoredListing, change: Partial<FakePoshmarkListing>): void {
    stored.previous = { ...stored.current };
    stored.current = { ...stored.current, ...change };
  }

  /**
   * The time of a change, to the second like Poshmark's, and always a later second than the
   * last change: the stand-in for Listora's pacing, which puts its changes seconds apart.
   */
  #tick(): Date {
    const now = Math.floor(Date.now() / 1000) * 1000;
    this.#clock = Math.max(now, this.#clock + 1000);
    return new Date(this.#clock);
  }

  #takeFault(action: FakePoshmarkAction): FakePoshmarkFault | undefined {
    const rule = this.#faults.find(
      (candidate) => candidate.action === action && candidate.remaining > 0,
    );
    if (rule === undefined) return undefined;
    rule.remaining -= 1;
    return rule.fault;
  }
}

// Routing -------------------------------------------------------------------------------------

interface Route {
  method: 'GET' | 'POST';
  action: FakePoshmarkAction;
  /** A listing id, or the closet's username. */
  id: string | null;
  /** Only a logged-in seller sees it. */
  private: boolean;
}

function matchRoute(method: string, path: string): Route | null {
  if (path === '/create-listing') {
    if (method === 'GET') return { method, action: 'new_form', id: null, private: true };
    if (method === 'POST') return { method, action: 'create', id: null, private: true };
  }
  const edit = /^\/edit-listing\/([0-9a-f]{24})$/.exec(path);
  if (edit?.[1] !== undefined) {
    if (method === 'GET') return { method, action: 'edit_form', id: edit[1], private: true };
    if (method === 'POST') return { method, action: 'update', id: edit[1], private: true };
  }
  const share = /^\/share-listing\/([0-9a-f]{24})$/.exec(path);
  if (method === 'POST' && share?.[1] !== undefined) {
    return { method, action: 'share', id: share[1], private: true };
  }
  const listing = /^\/listing\/(?:.*-)?([^/-]+)$/.exec(path);
  if (method === 'GET' && listing?.[1] !== undefined) {
    return { method, action: 'listing', id: listing[1], private: false };
  }
  if (method === 'GET' && path === '/offers/my_offers') {
    return { method, action: 'offers', id: null, private: true };
  }
  const offer = /^\/offers\/([\w-]+)(\/answer)?$/.exec(path);
  if (offer?.[1] !== undefined) {
    if (method === 'GET' && offer[2] === undefined) {
      return { method, action: 'offer', id: offer[1], private: true };
    }
    if (method === 'POST' && offer[2] !== undefined) {
      return { method, action: 'answer_offer', id: offer[1], private: true };
    }
  }
  const closet = /^\/closet\/([\w.-]+)$/.exec(path);
  if (method === 'GET' && closet?.[1] !== undefined) {
    return { method, action: 'closet', id: closet[1], private: false };
  }
  return null;
}

function loginRedirect(url: URL): Reply {
  return {
    status: 302,
    headers: { location: `/login?pmrd[url]=${encodeURIComponent(url.pathname)}` },
  };
}

function listingId(): string {
  return randomBytes(12).toString('hex');
}

function listingPath(listing: FakePoshmarkListing): string {
  const slug = listing.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `/listing/${slug === '' ? '' : `${slug}-`}${listing.id}`;
}

// The listing form ----------------------------------------------------------------------------

interface FormFields {
  title: string;
  description: string;
  brand: string;
  department: string;
  category: string;
  subcategory: string;
  sizeSet: string;
  size: string;
  condition: string;
  /** Comma-separated, as the picker's hidden field holds them. */
  colors: string;
  originalPrice: string;
  listingPrice: string;
  sku: string;
  availability: string;
}

function formFields(form: SubmittedForm): FormFields {
  return {
    title: form.text('title'),
    description: form.text('description'),
    brand: form.text('brand'),
    department: form.text('department'),
    category: form.text('category'),
    subcategory: form.text('subcategory'),
    sizeSet: form.text('size_set'),
    size: form.text('size'),
    condition: form.text('condition'),
    colors: form.text('colors'),
    originalPrice: form.text('originalPrice'),
    listingPrice: form.text('listingPrice'),
    sku: form.text('sku'),
    availability: form.text('availability'),
  };
}

function fieldsOf(listing: FakePoshmarkListing): FormFields {
  return {
    title: listing.title,
    description: listing.description,
    brand: listing.brand,
    department: listing.department,
    category: listing.category,
    subcategory: listing.subcategory ?? '',
    sizeSet: listing.sizeSet,
    size: listing.size,
    condition: listing.condition,
    colors: listing.colors.join(','),
    originalPrice:
      listing.originalPriceCents === null ? '' : String(listing.originalPriceCents / 100),
    listingPrice: String(listing.priceCents / 100),
    sku: listing.sku,
    availability: listing.inventory === 'not_for_sale' ? 'not_for_sale' : 'available',
  };
}

/** Poshmark's form rules, with messages in its style. */
function invalidListing(fields: FormFields, photos: number, creating: boolean): string[] {
  const problems: string[] = [];
  if (creating && photos === 0) problems.push('Please add at least one photo.');
  if (photos > POSHMARK_LIMITS.maxPhotos) problems.push('You can add up to 16 photos.');
  if (fields.title === '') problems.push('Title is required.');
  if (fields.title.length > POSHMARK_LIMITS.titleMaxLength) {
    problems.push('Title cannot be more than 80 characters.');
  }
  if (fields.description === '') problems.push('Description is required.');
  if (fields.description.length > POSHMARK_LIMITS.descriptionMaxLength) {
    problems.push('Description cannot be more than 1500 characters.');
  }
  const department = POSHMARK_DEPARTMENTS.find((name) => name === fields.department);
  const sets = department === undefined ? null : sizeSetsFor(department, fields.category);
  const subcategory = fields.subcategory === '' ? null : fields.subcategory;
  if (
    sets === null ||
    department === undefined ||
    poshmarkCatalog(department, fields.category, subcategory) === null
  ) {
    problems.push('Please select a category.');
  } else if (
    !(sets.find((set) => set.name === fields.sizeSet)?.sizes ?? []).some(
      ([id]) => id === fields.size,
    )
  ) {
    problems.push('Please select a size.');
  }
  const colors = colorList(fields.colors);
  if (
    colors.length > MAX_POSHMARK_COLORS ||
    colors.some((color) => !POSHMARK_COLORS.includes(color))
  ) {
    problems.push('Please select up to 2 colors.');
  }
  if (!Object.hasOwn(POSHMARK_CONDITIONS, fields.condition)) {
    problems.push('Please select a condition.');
  }
  const price = Number(fields.listingPrice);
  if (!/^\d+$/.test(fields.listingPrice) || price < 3 || price > 1_000_000) {
    problems.push('Listing price must be a whole number from $3.');
  }
  if (fields.originalPrice !== '' && !/^\d+$/.test(fields.originalPrice)) {
    problems.push('Original price must be a whole number.');
  }
  if (fields.availability !== 'available' && fields.availability !== 'not_for_sale') {
    problems.push('Please select the availability.');
  }
  return problems;
}

/** A valid form's fields as a listing's (`invalidListing` found no problem). */
function completeFields(
  fields: FormFields,
): Pick<
  FakePoshmarkListing,
  | 'sku'
  | 'title'
  | 'description'
  | 'brand'
  | 'department'
  | 'category'
  | 'subcategory'
  | 'sizeSet'
  | 'size'
  | 'condition'
  | 'colors'
  | 'priceCents'
  | 'originalPriceCents'
> {
  return {
    sku: fields.sku,
    title: fields.title,
    description: fields.description,
    brand: fields.brand,
    department: fields.department as PoshmarkDepartment,
    category: fields.category,
    subcategory: fields.subcategory === '' ? null : fields.subcategory,
    sizeSet: fields.sizeSet,
    size: fields.size,
    condition: fields.condition as PoshmarkConditionCode,
    colors: colorList(fields.colors),
    priceCents: Number(fields.listingPrice) * 100,
    originalPriceCents: fields.originalPrice === '' ? null : Number(fields.originalPrice) * 100,
  };
}

function colorList(text: string): string[] {
  return text === '' ? [] : text.split(',');
}

/**
 * The catalog the form's pickers offer, as Poshmark's own form holds it (catalog.json): each
 * department's categories in order, with their display group, subcategories, and size sets (a
 * size's id, its button's label, and what the picker shows once it is chosen).
 */
function catalogData(): Record<
  string,
  {
    name: string;
    group: string | null;
    subcategories: readonly string[];
    sets: { name: string; sizes: readonly (readonly string[])[] }[];
  }[]
> {
  return Object.fromEntries(
    POSHMARK_DEPARTMENTS.map((department) => [
      department,
      poshmarkCategories(department).map((category) => ({
        name: category,
        group: poshmarkCatalog(department, category)?.group ?? null,
        subcategories: subcategoriesOf(department, category) ?? [],
        sets: (sizeSetsFor(department, category) ?? []).map((set) => ({
          name: set.name,
          sizes: set.sizes,
        })),
      })),
    ]),
  );
}

/** The availability picker's items: Poshmark's own codes, with the labels the picker shows. */
const AVAILABILITIES = [
  ['available', 'For Sale'],
  ['not_for_sale', 'Not For Sale'],
] as const;

/** The form's own message for each required field, which Next shows when the field is empty. */
const REQUIRED_MESSAGES = {
  photos: 'Please add at least one photo.',
  title: 'Title is required.',
  description: 'Description is required.',
  category: 'Please select a category.',
  size: 'Please select a size.',
  condition: 'Please select a condition.',
  listingPrice: 'Listing price is required.',
} as const;

/** The pickers' choices, which the form sends in hidden fields. */
const PICKED_FIELDS = [
  'department',
  'category',
  'subcategory',
  'size_set',
  'size',
  'condition',
  'colors',
  'availability',
] as const;

/**
 * Poshmark's listing editor as poshmark/pages/listing-form.ts reads it: text fields named by
 * their validation names, the photo picker, dropdown pickers whose menus are drawn only while
 * they are open, the brand field, the prices (the listing price opens the Listing Price
 * dialog), the SKU in the private details a link shows, and the availability. A new listing has
 * Next and then the share step's List; a change has Update and then the same share step's List.
 * `EDITOR_SCRIPT` runs it all.
 */
function listingForm(
  action: string,
  values: FormFields | null,
  errors: readonly string[],
  editing: boolean,
  draft: string | null,
): string {
  const value = (text: string | undefined): string => escape(text ?? '');
  // Every message the form can show is in the page; Vue's v-show hides the ones that don't apply.
  const required = (field: keyof typeof REQUIRED_MESSAGES): string =>
    `<p class="form__error-message" data-field="${field}" style="display: none;">${escape(REQUIRED_MESSAGES[field])}</p>`;
  const dropdown = (container: string, selector = ''): string =>
    `<div ${container}><div class="dropdown__selector"${selector}></div><div class="dropdown__menu" hidden></div></div>`;
  const editor = {
    catalog: catalogData(),
    colors: POSHMARK_COLORS,
    // The condition picker shows Poshmark's labels (`New With Tags (NWT)`, read 2026-10-27).
    conditions: Object.entries(POSHMARK_CONDITIONS),
    availabilities: AVAILABILITIES,
    selection: {
      department: values?.department ?? null,
      category: values?.category ?? null,
      subcategory: values?.subcategory ?? null,
      size_set: values?.sizeSet ?? null,
      size: values?.size ?? null,
      condition: values?.condition ?? null,
      colors: values?.colors ?? '',
      availability: values?.availability ?? 'available',
      sku: values?.sku ?? '',
    },
  };
  const named = draft === null ? '' : ` data-et-prop-listing_id="${escape(draft)}"`;
  const photos = `<section id="imagePlaceholder" data-et-name="listingEditorImageSection"${named}><h2>Photos</h2>${draft === null ? '' : `<input type="hidden" name="listing_id" value="${escape(draft)}">`}
<input type="file" id="img-file-input" aria-label="img-file-input" multiple accept="image/jpeg">
<input type="file" name="photos" multiple hidden>${required('photos')}
</section>`;
  // A change's Update opens the same share step a new listing's Next does, whose List This Item
  // saves it (as Poshmark's edit page does, read 2026-10-27).
  const publish = editing
    ? '<button type="button" data-et-name="update">Update</button><section id="share-step" hidden><h2>Share</h2><button type="submit" data-et-name="list">List This Item</button></section>'
    : '<button type="button" data-et-name="next">Next</button><section id="share-step" hidden><h2>Share</h2><button type="submit" data-et-name="list">List This Item</button></section>';
  return `<form id="listing-editor" method="post" action="${action}" enctype="multipart/form-data">
${errors.map((error) => `<p class="form__error-message">${escape(error)}</p>`).join('')}
${editing ? '' : photos}
<section><h2>Listing details</h2>
<input type="text" data-vv-name="title" name="title" placeholder="What are you selling? (required)" value="${value(values?.title)}">${required('title')}
<textarea data-vv-name="description" name="description" placeholder="Describe it! (required)">${value(values?.description)}</textarea>${required('description')}
${dropdown('class="listing-editor__category-container"')}${required('category')}
${dropdown('class="listing-editor__subcategory-container"')}
${dropdown('class="listing-editor__size-container"', ' data-test="size"')}${required('size')}
${dropdown('class="listing-editor__condition-container"')}${required('condition')}
<div class="listing-editor__color-container"><div class="dropdown__selector"><div data-et-name="color"></div></div><div class="dropdown__menu" hidden></div></div>
<div data-et-name="listingEditorBrandSection"><input type="text" name="brand" placeholder="Enter the Brand" value="${value(values?.brand)}"></div>
</section>
<section><h2>Pricing</h2>
<input type="number" data-vv-name="originalPrice" name="originalPrice" placeholder="Original Price" value="${value(values?.originalPrice)}">
<input type="number" data-vv-name="listingPrice" name="listingPrice" placeholder="Listing Price (required)" value="${value(values?.listingPrice)}">${required('listingPrice')}
</section>
<section class="listing-editor__toggle"><h2>Additional Details (PRIVATE)</h2><a class="listing-editor-toggle-link">show details</a>
<div hidden><input type="text" data-vv-name="sku" name="sku" placeholder="SKU"></div>
</section>
${dropdown('data-et-name="listingEditorAvailabilitySection"')}
${PICKED_FIELDS.map((name) => `<input type="hidden" name="${name}">`).join('')}
${publish}
</form>
${PRICE_DIALOG}
<script type="application/json" id="editor-data">${json(editor)}</script>
<script>${EDITOR_SCRIPT}</script>`;
}

/**
 * The Listing Price dialog the price field opens: the price again, Automate Offers (on, and
 * then it wants the lowest price an offer may reach), the original price, and Done, which puts
 * the prices in the form. Closed, it stays in the page without `modal--in`.
 */
const PRICE_DIALOG = `<div class="modal listing-price-suggestion-modal" style="display: none;">
<div class="modal__header"><h2>Listing Price</h2></div>
<div class="modal__body">
<label for="listing-price-modal-listing-price-input">Listing Price</label><input type="number" id="listing-price-modal-listing-price-input">
<label data-test="toggle-switch"><input type="checkbox" checked>Automate Offers</label>
<div data-test="automate-offers"></div>
<p class="form__error-message" style="display: none;">Enter the lowest price you would accept, or turn off Automate Offers.</p>
<label for="listing-price-modal-original-price-input">Original Price</label><input type="number" id="listing-price-modal-original-price-input">
</div>
<div class="modal__footer" data-test="modal-footer"><button type="button" class="btn btn--primary">Done</button></div>
</div>`;

/** Runs the listing editor in the page, as Poshmark's own scripts do. */
/** How long after the rest of an edit page's form its price section is drawn. */
const EDIT_PRICE_DRAWN_MS = 2_000;

const EDITOR_SCRIPT = `(() => {
  const data = JSON.parse(document.getElementById('editor-data').textContent);
  const { catalog, colors, conditions, availabilities } = data;
  const state = data.selection;
  const form = document.getElementById('listing-editor');
  const make = (tag, attributes, children) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    node.append(...children);
    return node;
  };
  const item = (tag, attributes, content, choose) => {
    const node = make(tag, attributes, [content]);
    node.addEventListener('click', choose);
    return node;
  };
  const labelOf = (pairs, code) => (pairs.find((pair) => pair[0] === code) || [])[1];
  const chosenCategory = () => (catalog[state.department] || []).find((entry) => entry.name === state.category) || null;

  // A picker opens on its selector; its menu is drawn only while it is open, and opening one
  // picker closes the others.
  const pickers = [];
  const dropdown = (container, draw) => {
    const selector = container.querySelector('.dropdown__selector');
    const menu = container.querySelector('.dropdown__menu');
    const picker = {
      open: () => {
        for (const other of pickers) if (other !== picker) other.close();
        menu.replaceChildren(...draw());
        menu.hidden = false;
      },
      close: () => {
        menu.replaceChildren();
        menu.hidden = true;
      },
      redraw: () => menu.replaceChildren(...draw()),
      show: (text) => {
        selector.textContent = text;
      },
    };
    selector.addEventListener('click', () => (menu.hidden ? picker.open() : picker.close()));
    pickers.push(picker);
    return picker;
  };

  // The catalog lists the departments, then the categories of the one clicked (a display group's
  // categories once the group is clicked); a category with subcategories opens the subcategory
  // picker. Once a category is chosen, the picker opens on its department, with All Categories
  // to go back to the departments.
  let browsing = state.category ? state.department : null;
  let openGroup = null;
  const category = dropdown(form.querySelector('.listing-editor__category-container'), () => {
    if (browsing === null) {
      return [make('ul', {}, [allCategories(), ...Object.keys(catalog).map((name) =>
        make('li', {}, [item('a', { class: 'dropdown__menu__item' }, make('div', {}, [make('p', {}, [name])]), () => {
          browsing = name;
          openGroup = null;
          category.redraw();
        })]))])];
    }
    const entries = [];
    const groups = new Set();
    for (const entry of catalog[browsing] || []) {
      if (entry.group === null) {
        entries.push(categoryItem(entry));
        continue;
      }
      if (!groups.has(entry.group)) {
        groups.add(entry.group);
        const group = entry.group;
        entries.push(item('li', { class: 'dropdown__menu__item' }, make('div', {}, [group]), () => {
          openGroup = openGroup === group ? null : group;
          category.redraw();
        }));
      }
      if (openGroup === entry.group) entries.push(categoryItem(entry));
    }
    return [
      make('ul', {}, [
        allCategories(),
        make('li', {}, [item('a', { class: 'dropdown__menu__item' }, make('div', {}, [make('p', {}, [browsing])]), () => category.redraw())]),
      ]),
      make('ul', {}, entries),
    ];
  });
  const allCategories = () =>
    make('li', {}, [item('a', { class: 'dropdown__menu__item', 'data-et-name': 'all' }, make('div', {}, [make('p', {}, ['All Categories'])]), () => {
      browsing = null;
      category.redraw();
    })]);
  // A category's name is in a div inside its item, as on Poshmark.
  const categoryItem = (entry) =>
    item('li', { class: 'dropdown__menu__item' }, make('div', {}, [entry.name]), () => {
      Object.assign(state, { department: browsing, category: entry.name, subcategory: null, size_set: null, size: null });
      // A one-size category's size is chosen with it.
      const usable = entry.sets.filter((set) => set.sizes.length > 0);
      if (usable.length > 0 && usable.every((set) => set.sizes.length === 1)) {
        Object.assign(state, { size_set: usable[0].name, size: usable[0].sizes[0][0] });
      }
      category.close();
      render();
      if (entry.subcategories.length > 0) subcategory.open();
    });
  const subcategory = dropdown(form.querySelector('.listing-editor__subcategory-container'), () =>
    (chosenCategory() === null || chosenCategory().subcategories.length === 0
      ? []
      : [...chosenCategory().subcategories, 'None']
    ).map((name) =>
      item('a', { 'data-et-name': 'sub_category' }, name, () => {
        state.subcategory = name === 'None' ? null : name;
        subcategory.close();
        render();
      })));

  // The size picker has a tab per size set and a button per size, which shows the size's label
  // (Neck 15.5, Waist 32, 2T); once chosen, the picker shows what Poshmark shows for it. One size
  // applies on its click and closes the picker; Done is for several sizes.
  let tab = null;
  const setsOf = () => (chosenCategory() === null ? [] : chosenCategory().sets);
  const size = dropdown(form.querySelector('.listing-editor__size-container'), () => {
    const sets = setsOf();
    const names = sets.map((set) => set.name);
    if (!names.includes(tab)) tab = names.includes(state.size_set) ? state.size_set : (names[0] || null);
    const shown = sets.find((set) => set.name === tab);
    return [
      make('ul', { 'data-test': 'horizontal-list' }, [...names, 'Custom'].map((name) =>
        item('li', { class: 'navigation--horizontal__tab' }, make('span', {}, [name]), () => {
          tab = name;
          size.redraw();
        }))),
      make('div', { class: 'multi-size-selector' }, (shown ? shown.sizes : []).map(([id, label]) =>
        item('button', { type: 'button', class: 'multi-size-selector__button' }, label, () => {
          Object.assign(state, { size_set: tab, size: id });
          size.close();
          render();
        }))),
      item('button', { type: 'button', class: 'btn btn--primary', 'data-et-name': 'apply', 'data-et-on-name': 'multi_item_quantity_tile' }, 'Done', () => size.close()),
    ];
  });
  const chosenSize = () => {
    const set = setsOf().find((entry) => entry.name === state.size_set);
    const found = set && set.sizes.find(([id]) => id === state.size);
    return found ? found[2] : null;
  };

  // The color picker: a tile per color whose circle holds a checkmark once it is chosen, up to
  // two, and Done.
  const chosenColors = () => (state.colors ? state.colors.split(',') : []);
  const colorContainer = form.querySelector('.listing-editor__color-container');
  const color = dropdown(colorContainer, () => [
    make('ul', {}, colors.map((name) => {
      const chosen = chosenColors().includes(name);
      const circle = make('a', { class: 'color__circle--large', style: 'display: inline-block; width: 24px; height: 24px;' }, chosen ? [make('i', { class: 'checkmark checkmark--white' }, [])] : []);
      circle.addEventListener('click', () => {
        const now = chosenColors();
        if (now.includes(name)) state.colors = now.filter((entry) => entry !== name).join(',');
        else if (now.length < ${String(MAX_POSHMARK_COLORS)}) state.colors = [...now, name].join(',');
        color.redraw();
        render();
      });
      return make('li', { class: 'listing-editor__tile--color' }, [make('div', {}, [circle, make('span', {}, [name])])]);
    })),
    item('button', { type: 'button', class: 'btn btn--primary', 'data-et-name': 'apply', 'data-et-on-name': 'color_tile' }, 'Done', () => color.close()),
  ]);

  const condition = dropdown(form.querySelector('.listing-editor__condition-container'), () =>
    conditions.map(([code, title]) =>
      item('div', { 'data-et-name': 'listing_condition' }, make('div', { class: 'fw--med' }, [title]), () => {
        state.condition = code;
        condition.close();
        render();
      })));

  const availability = dropdown(form.querySelector('[data-et-name="listingEditorAvailabilitySection"]'), () =>
    availabilities.map(([code, label]) =>
      item('a', { class: 'dropdown__link', 'data-et-name': code }, label, () => {
        state.availability = code;
        availability.close();
        render();
      })));

  const render = () => {
    for (const name of ${json(PICKED_FIELDS)}) {
      form.querySelector('input[type="hidden"][name="' + name + '"]').value = state[name] || '';
    }
    category.show(state.category ? state.department + ' / ' + state.category : 'Select Category');
    subcategory.show(state.subcategory || 'Select Subcategory');
    size.show(chosenSize() || 'Select Size');
    colorContainer.querySelector('[data-et-name="color"]').textContent = chosenColors().join('') || 'Select up to 2 colors';
    condition.show(labelOf(conditions, state.condition) || 'Select Condition');
    availability.show(labelOf(availabilities, state.availability) || 'Select Availability');
  };

  // Additional Details (PRIVATE) shows the SKU field once its link is clicked. Vue sets the
  // field's value itself, so the field has no value attribute.
  const details = form.querySelector('.listing-editor__toggle a.listing-editor-toggle-link');
  details.addEventListener('click', () => {
    details.nextElementSibling.hidden = !details.nextElementSibling.hidden;
    details.textContent = details.nextElementSibling.hidden ? 'show details' : 'hide details';
  });
  form.querySelector('input[data-vv-name="sku"]').value = state.sku;

  // Picking photos opens the cover-photo editor; only its Apply keeps them for the listing.
  const picker = form.querySelector('#img-file-input');
  const kept = form.querySelector('input[type="file"][name="photos"]');
  if (picker !== null) {
    picker.addEventListener('change', () => {
      for (const open of document.querySelectorAll('.photo-editor')) open.remove();
      if (picker.files.length === 0) return;
      const cancel = make('button', { type: 'button', class: 'btn btn--tertiary', 'data-et-name': 'cancel' }, ['Cancel']);
      const apply = make('button', { type: 'button', class: 'btn btn--primary', 'data-et-name': 'apply' }, ['Apply']);
      const editor = make('div', { class: 'modal modal--in photo-editor' }, [
        make('div', { class: 'modal__body image-edit-modal' }, [make('p', {}, ['Edit cover photo'])]),
        make('div', { class: 'modal__footer', 'data-test': 'modal-footer' }, [cancel, apply]),
      ]);
      apply.addEventListener('click', () => {
        kept.files = picker.files;
        editor.remove();
      });
      cancel.addEventListener('click', () => editor.remove());
      document.body.append(editor);
    });
  }

  // The price field opens the Listing Price dialog; its Done puts the dialog's prices in the
  // form. Automate Offers stays on until it is switched off, and while on it wants a lowest price.
  const price = form.querySelector('input[data-vv-name="listingPrice"]');
  const original = form.querySelector('input[data-vv-name="originalPrice"]');
  const dialog = document.querySelector('.listing-price-suggestion-modal');
  const dialogPrice = dialog.querySelector('#listing-price-modal-listing-price-input');
  const dialogOriginal = dialog.querySelector('#listing-price-modal-original-price-input');
  const offers = dialog.querySelector('label[data-test="toggle-switch"] input');
  const lowest = dialog.querySelector('[data-test="automate-offers"]');
  const offersMessage = dialog.querySelector('.form__error-message');
  const drawLowest = () => {
    lowest.replaceChildren(...(offers.checked ? [make('input', { type: 'number', 'data-vv-name': 'inputPrice', placeholder: 'Lowest Price' }, [])] : []));
  };
  offers.addEventListener('change', drawLowest);
  drawLowest();
  price.addEventListener('focus', () => {
    if (dialog.classList.contains('modal--in')) return;
    dialogPrice.value = price.value;
    dialogOriginal.value = original.value;
    dialog.style.display = '';
    dialog.classList.add('modal--in');
  });
  dialog.querySelector('button.btn--primary').addEventListener('click', () => {
    const floor = lowest.querySelector('input');
    const wantsFloor = floor !== null && floor.value.trim() === '';
    offersMessage.style.display = wantsFloor ? '' : 'none';
    if (wantsFloor) return;
    price.value = dialogPrice.value;
    original.value = dialogOriginal.value;
    dialog.classList.remove('modal--in');
    dialog.style.display = 'none';
  });

  // Next shows the messages of the required fields left empty, or else the share step, whose
  // List publishes the listing.
  const next = form.querySelector('button[data-et-name="next"]');
  if (next !== null) {
    next.addEventListener('click', () => {
      const empty = {
        photos: kept.files.length === 0,
        title: form.querySelector('input[data-vv-name="title"]').value.trim() === '',
        description: form.querySelector('textarea[data-vv-name="description"]').value.trim() === '',
        category: !state.category,
        size: !state.size,
        condition: !state.condition,
        listingPrice: price.value.trim() === '',
      };
      for (const message of form.querySelectorAll('.form__error-message[data-field]')) {
        message.style.display = empty[message.getAttribute('data-field')] ? '' : 'none';
      }
      form.querySelector('#share-step').hidden = Object.values(empty).some(Boolean);
    });
  }

  const update = form.querySelector('button[data-et-name="update"]');
  if (update !== null) {
    update.addEventListener('click', () => {
      form.querySelector('#share-step').hidden = false;
    });
    // An edit page draws its price section a moment after the rest of the form (seen on the
    // captain's session, 2026-10-27); the form keeps the listing's prices meanwhile.
    const pricing = price.closest('section');
    const held = [price, original].map((field) =>
      make('input', { type: 'hidden', name: field.name, value: field.value }, []),
    );
    pricing.replaceWith(...held);
    setTimeout(() => held[0].replaceWith(pricing), ${String(EDIT_PRICE_DRAWN_MS)});
    setTimeout(() => held[1].remove(), ${String(EDIT_PRICE_DRAWN_MS)});
  }

  render();
})();`;

// Pages ---------------------------------------------------------------------------------------

/**
 * A listing as Poshmark's pages embed it, with its photos on the fake's own image CDN
 * (`/media/`, fake-photos.ts) as `cover_shot` and `pictures`.
 */
function listingRecord(listing: FakePoshmarkListing, origin: string): Record<string, unknown> {
  const photo = (index: number) => {
    const url = `${origin}/media/${fakeMediaName(`${listing.id}-${String(index)}`)}.jpg`;
    return { id: `${listing.id}-${String(index)}`, url, url_small: url, url_large: url };
  };
  const [cover, ...rest] = listing.photoSizes.map((_size, index) => photo(index));
  const money = (cents: number) => ({
    val: (cents / 100).toFixed(1),
    currency_code: 'USD',
    currency_symbol: '$',
  });
  return {
    id: listing.id,
    status: listing.reviewing ? 'for_review' : 'published',
    status_changed_at: poshmarkTime(listing.createdAt),
    created_at: poshmarkTime(listing.createdAt),
    updated_at: poshmarkTime(listing.updatedAt),
    title: listing.title,
    description: listing.description,
    brand: listing.brand,
    size: listing.size,
    condition: listing.condition,
    price_amount: money(listing.priceCents),
    original_price_amount: money(listing.originalPriceCents ?? 0),
    inventory: {
      status: listing.inventory,
      status_changed_at: poshmarkTime(listing.inventoryChangedAt),
    },
    department: { display: listing.department },
    category_v2: { display: listing.category },
    category_features: listing.subcategory === null ? [] : [{ display: listing.subcategory }],
    creator_username: listing.seller,
    picture_url: cover?.url ?? null,
    cover_shot: cover ?? null,
    pictures: rest,
  };
}

function listingBody(listing: FakePoshmarkListing, viewer: string | null): string {
  const badge =
    listing.inventory === 'sold_out'
      ? 'Sold'
      : listing.inventory === 'not_for_sale'
        ? 'Not For Sale'
        : '';
  return `<main data-test="listing"><h1 class="listing__title">${escape(listing.title)}</h1>
<p class="listing__price">$${String(listing.priceCents / 100)}</p>
${badge === '' ? '' : `<span class="listing__status">${badge}</span>`}
<div class="listing__description">${escape(listing.description)}</div>${
    viewer === listing.seller && listing.inventory === 'available' ? shareControls(listing) : ''
  }</main>`;
}

/**
 * The listing page's Share, and its sheet's To My Followers, as the seller sees them on their own
 * available listing.
 */
function shareControls(listing: FakePoshmarkListing): string {
  return `<button type="button" data-et-name="share" onclick="document.getElementById('share-sheet').hidden=false">Share</button>
<div id="share-sheet" class="share-modal" hidden><h3>Share this listing</h3>
<form method="post" action="/share-listing/${listing.id}"><button type="submit" data-et-name="share_poshmark">To My Followers</button></form></div>`;
}

/**
 * Poshmark's own end of the script that embeds a page's data: it takes itself out of the page
 * once it ran, so a ready page keeps the data only in its global (read 2026-10-26).
 */
const REMOVE_SELF =
  '(function(){var s;(s=document.currentScript||document.scripts[document.scripts.length-1]).parentNode.removeChild(s);}());';

/** A page with Poshmark's embedded data: who is logged in, and the page's own data. */
function page(
  title: string,
  body: string,
  seller: string | null,
  data: Record<string, unknown> = {},
): string {
  // As Poshmark's pages have it: the user's id in `auth.identity`, the handle closets are
  // addressed by in `userCookies.userInfo.dh`, and no `userInfo` signed out.
  const state = {
    auth: {
      isUserLoggedIn: seller !== null,
      identity: seller === null ? null : userId(seller),
      isGuestLoggedIn: false,
    },
    userCookies: {
      permanentSession: {},
      ...(seller === null ? {} : { userInfo: { uid: userId(seller), dh: seller } }),
    },
    ...data,
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body>${body}<script>window.__INITIAL_STATE__=${json(state)};${REMOVE_SELF}</script></body></html>`;
}

/** A seller's id, as Poshmark's 24-hex ids look. */
function userId(seller: string): string {
  return createHash('sha256').update(seller).digest('hex').slice(0, 24);
}

function notFound(seller: string | null): string {
  return page('Page Not Found | Poshmark', '<p>Sorry, we could not find that page.</p>', seller, {
    $_listing_details: { listingDetails: null },
  });
}

/**
 * A listing's page once it is off the site: Poshmark's record of what became of it, read on the
 * captain's listings (2026-10-27).
 */
function removedPage(id: string, status: 'archived' | 'hidden', seller: string | null): string {
  return page('Poshmark: Buy and sell fashion, home decor, beauty & more', '', seller, {
    $_listing_details: {
      listingDetails: {
        error: {
          errorType: 'PostRemovedError',
          params: { post_info: { id, status } },
          statusCode: 404,
        },
        meta: { api_url: `/listing/${id}` },
      },
    },
  });
}

function loginForm(): string {
  return `<form method="post" action="/login"><input name="login_form[username_email]" placeholder="Username or Email"><input type="password" name="login_form[password]" placeholder="Password"><button type="submit">Log In</button></form>`;
}

function otpModal(): string {
  return `<div class="modal" data-test="otp-modal"><h2>Verify it's you</h2><p>Enter the 6-digit code we sent to your email.</p><input name="otp"></div>`;
}

function captchaModal(): string {
  return `<div class="modal" data-test="captcha-modal"><p>Please complete the security check to continue.</p><div class="g-recaptcha" data-sitekey="fake-site-key" style="width:304px;height:78px;border:1px solid #ccc"></div></div>`;
}

/** Poshmark's time format: Pacific time to the second, with its offset. */
function poshmarkTime(date: Date): string {
  const pacific = new Date(date.getTime() - 7 * 3_600_000);
  return `${pacific.toISOString().slice(0, 19)}-07:00`;
}

/** JSON safe inside a script element. */
function json(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}
