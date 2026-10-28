/**
 * The fake Depop site: a local web app with the pages and flows of Depop's website that the
 * Depop automation adapter uses (docs/features/depop-automation.md), for its development and
 * tests. No test sends traffic to Depop. It models Depop's pages as the page modules read them
 * (`depop/pages/`, read on the live site in 2026-10), with the pages themselves in
 * fake-depop-pages.ts: pages whose parts Depop's own scripts draw after the document is ready,
 * the header's user menu whose "Your profile" opens the seller's shop, the shop's links to the
 * seller's products, a product page's App Router data (`self.__next_f.push` rows holding the
 * product's query data) and its schema.org price, the sell form's comboboxes (category groups,
 * the size list, the brand search, the condition) with Depop's own item info from the photos,
 * its validation, and its Done page after a Post, the product page's Delete listing with its
 * dialog, the selling hub's listings with pagination (still in `script#__NEXT_DATA__`, as its
 * page module reads them), its sold items (receipts drawn after load, or the note a seller
 * without sales sees), and Depop's checks (a bot-check page, a CAPTCHA, a login code, a
 * logged-out session), with fault injection for each.
 *
 *   GET  /login/                       the login page (a password field: no session needs it)
 *   POST /login/                       log in by hand: any username and password; sets the session cookie
 *   POST /login/email-link/            email me a sign-in link: "sends" a one-time link (`signInLinks()`)
 *   GET  /login/magic-link/?token=     the emailed link: signs in once and sets the session cookie
 *   GET  /login/verify/                a login code step
 *   GET  /sellinghub/                  the selling hub, its header (the avatar, the user menu) drawn by its script
 *   GET  /<username>/                  a seller's shop: links to their products for sale, newest first
 *   GET  /products/create/             the sell form; POST lists (multipart, photos)
 *   GET  /products/create/done/        the Done page a Post opens
 *   GET  /products/:slug/              a product's page (its data: text, status; its price)
 *   GET  /products/edit/:slug/         the edit form; POST saves it
 *   POST /products/edit/:slug/delete   delete (the product page's Delete listing, confirmed)
 *   GET  /sellinghub/selling/          the seller's listings for sale; `?page=N`, 10 a page
 *   GET  /sellinghub/sold-items/       the seller's sold items: a receipt link for each sale, or a note
 *   GET  /presentation/api/v1/receipts/ the seller's receipts (web API), as the sold items page loads
 *                                      them; a receipt's own fields are Listora's assumption until a
 *                                      real sale shows them (depop/pages/receipts.ts)
 *   GET  /presentation/api/v1/offers/me/products/ buyers' offers on the seller's products (web API),
 *                                      as the Offers page loads them (fields: Listora's assumption,
 *                                      depop/pages/offers.ts)
 *   GET  /sellinghub/offers/<id>/      an offer's page (fake-offers/); POST .../answer answers it
 *   GET  /photos/<name>.jpg            a photo, standing in for Listora's image CDN (no session)
 *   GET  /media/<name>.jpg             a listing's photo on Depop's own image CDN (no session)
 *
 * Every page except the login pages and photos needs the session cookie; without a valid one it
 * redirects to the login page. Depop usernames are letters, numbers, periods, and underscores,
 * and a product's slug starts with its seller's username. A product's change time grows by at
 * least a second with every change (automated changes are seconds apart), so the selling page
 * shows it as a revision; a stale read serves the product as it was before its latest change. A
 * product its seller deleted stays readable with the status `STATUS_DELETED` (the shared
 * conformance suite reads an ended listing back as ended); `gone` makes its page answer 410 Gone
 * instead, as Depop's did for a listing Listora deleted (2026-10-27). An unknown slug is a plain
 * 404.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SessionCookie } from '@listora/connections';
import { DEPOP_EMAIL_ADDRESS } from '@listora/shared';

import {
  cookieValue,
  delay,
  readForm,
  redirect,
  type Reply,
  type SubmittedForm,
} from '../../fake-site/http.ts';
import { FakeOfferDesk, fakeOfferPageBody, type FakeOffer } from '../../fake-offers/fake-offers.ts';
import { FAKE_MEDIA_PATH, fakeMediaName, fakeMediaPhoto } from '../../fake-photos/fake-photos.ts';
import { allDepopCategories } from '../categories.ts';
import { DEPOP_CONDITION_LABELS } from '../conditions.ts';
import { DEPOP_SLUG } from '../site.ts';
import {
  botCheckPage,
  captchaWidget,
  donePage,
  emailLinkSentPage,
  expiredLinkPage,
  FAKE_DEPOP_BRANDS,
  FAKE_DEPOP_DETAILS,
  FAKE_DEPOP_OTHER_BRAND,
  FAKE_DEPOP_SHIPPING,
  fakeDepopTree,
  gonePage,
  hubPage,
  listingFormPage,
  loginPage,
  notFoundPage,
  plainPage,
  priceAmount,
  productPage,
  soldItemsPage,
  verifyPage,
} from './fake-depop-pages.ts';

export { FAKE_DEPOP_BRANDS, FAKE_DEPOP_SHIPPING } from './fake-depop-pages.ts';

/**
 * The pages, API reads, and submissions a fault can be injected into: `health` is the selling
 * hub, `read` a product's page (where Delete listing is) and the API's read of the seller's own
 * product, `form` the sell and edit forms, `create` and `update` their submissions, `done` the
 * Done page after a Post, `delete` the confirmed Delete listing, `listings` the API's list of
 * the seller's own listings, and `sold` the selling hub's sold items.
 */
export type FakeDepopSiteAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'read'
  | 'done'
  | 'listings'
  | 'sold'
  | 'receipts'
  | 'receipt'
  | 'health'
  | 'form'
  | 'offers'
  | 'offer'
  | 'answer_offer';

export type FakeDepopSiteFault =
  /** A bot-check page ("Please verify you are a human") instead of the page, status 403. */
  | { type: 'bot_check' }
  /** The page, with a CAPTCHA widget over it (status 200). */
  | { type: 'captcha' }
  /** A redirect to a login code step. */
  | { type: 'login_challenge' }
  /** The session is invalidated, and the page redirects to the login page. */
  | { type: 'session_expired' }
  | { type: 'rate_limited'; retryAfterSeconds?: number }
  /** A 500 page; with `afterApply`, the change was made first. */
  | { type: 'server_error'; afterApply?: boolean }
  /** A form submission comes back with this validation message; nothing is applied. */
  | { type: 'reject'; message: string }
  /** The answer comes after `delayMs`; with `afterApply`, the change is made at once. */
  | { type: 'slow'; delayMs: number; afterApply: boolean }
  /** A read serves the product as it was before its latest change. */
  | { type: 'stale_read' }
  /** The page without the elements and data the adapter reads, as after a site redesign. */
  | { type: 'redesigned' };

export interface FakeDepopSiteFaultRule {
  action: FakeDepopSiteAction;
  fault: FakeDepopSiteFault;
  /** How many matching requests get it (default 1). */
  times?: number;
}

/** Depop's product statuses, which its pages show as `STATUS_ONSALE`, ... */
/** `PURCHASED`: a buyer bought it through Depop (Depop's own status since 2026-10-28's read). */
export type FakeDepopStatus = 'ONSALE' | 'PURCHASED' | 'MARKED_AS_SOLD' | 'DELETED';

export interface FakeDepopProduct {
  slug: string;
  /** The username of the seller whose session listed it; their shop shows only their own. */
  seller: string;
  status: FakeDepopStatus;
  /** The whole listing text, as the form's description field got it. */
  description: string;
  /** The price a buyer pays now (the reduced one, when the seller marked it down). */
  priceCents: number;
  /** The price before a markdown; `null` when it has none. Only seeded. */
  originalPriceCents: number | null;
  /** Department, category, product type. */
  category: string[];
  size: string | null;
  brand: string | null;
  condition: string;
  /** The form's colour and material picks, by their labels. */
  colours: string[];
  materials: string[];
  /** The form's other item specifics and style picks, by picker (`attributes.dress-length`). */
  details: Record<string, string[]>;
  /** Whether "Boost your listing" was on when it was posted or saved. */
  boosted: boolean;
  shipping: string;
  /** Uploaded photo file names, in the order the form sent them. */
  photos: string[];
  listedAt: Date;
  updatedAt: Date;
  soldAt: Date | null;
}

export interface FakeDepopSiteRequest {
  method: string;
  path: string;
  action: FakeDepopSiteAction | null;
  at: number;
  fault: FakeDepopSiteFault['type'] | null;
  status: number;
}

export interface FakeDepopSiteOptions {
  /** Products per page of the selling hub's lists (default 10). */
  pageSize?: number;
  /**
   * The shipping choice the form starts with, as Depop remembers the seller's (default Depop
   * Shipping); `null` for a seller who has set none up.
   */
  defaultShipping?: string | null;
  /** Called with each sign-in link the site "emails" (the dev CLI prints it). */
  onSignInLink?: (link: string) => void;
  /** Whether the form starts with "Boost your listing" on (Depop's own default is off). */
  boostByDefault?: boolean;
}

interface StoredProduct {
  /** Depop's numeric id for the product. */
  id: number;
  current: FakeDepopProduct;
  previous: FakeDepopProduct | null;
  /** Depop no longer serves it: its page answers 410 Gone. */
  gone: boolean;
  /** Depop's id for the purchase once it sold. */
  purchaseId: number | null;
  /** The sale's shipping label and buyer's first name, once it sold. */
  shipping?: FakeDepopShipping;
  /** What the buyer paid for it (an accepted offer may be less than its price), once it sold. */
  paidCents?: number;
  /** Whether the purchase shipped (`shipped`) or still waits to (`shipping_pending`). */
  purchaseStatus?: FakeDepopPurchaseStatus;
}

/** A sale's label, as a receipt shows it. */
export interface FakeDepopShipping {
  trackingNumber: string | null;
  buyerFirstName: string | null;
}

/** A receipt's status, as Depop's receipts name them. */
export type FakeDepopPurchaseStatus = 'shipping_pending' | 'shipped' | 'cancelled';

/** How a fake purchase went: what the buyer paid and whether it shipped. */
export interface FakeDepopPurchase {
  paidCents?: number;
  status?: FakeDepopPurchaseStatus;
}

interface Session {
  /** The seller's username. */
  seller: string;
}

interface Route {
  method: 'GET' | 'POST';
  action: FakeDepopSiteAction;
  /** The product's slug. */
  slug: string | null;
  /** A read of Depop's web API (JSON, with the session's token as the bearer token). */
  api?: boolean;
}

const SESSION_COOKIE = 'fake_depop_session';
/** The cookie Depop's pages keep the session's API token in, readable by their scripts. */
const TOKEN_COOKIE = 'access_token';
const DEFAULT_SELLER = 'fake_seller';
const PHOTO_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const LIMITS = { description: 1_000, hashtags: 5, photos: 8, minCents: 100 };
/** A Depop username, lowercase as the fake keeps them. */
const USERNAME = /^[a-z0-9][a-z0-9._]{1,29}$/;

export class FakeDepopSite {
  readonly #server: Server;
  readonly #pageSize: number;
  readonly #defaultShipping: string | null;
  readonly #boostByDefault: boolean;
  readonly #products = new Map<string, StoredProduct>();
  readonly #sessions = new Map<string, Session>();
  /** Emailed sign-in links not used yet, by token: the seller each one signs in. */
  readonly #signInTokens = new Map<string, string>();
  readonly #signInLinks: string[] = [];
  readonly #onSignInLink: ((link: string) => void) | undefined;
  readonly #faults: (FakeDepopSiteFaultRule & { remaining: number })[] = [];
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly requests: FakeDepopSiteRequest[] = [];
  /** An `offer_display_status` every offer shows instead of its own (an unknown status). */
  offerStatusOverride: string | null = null;

  /** The id of the product with this slug, as Depop's web API names it. */
  productId(slug: string): number | undefined {
    return this.#products.get(slug)?.id;
  }

  /** Buyers' offers on the seller's products, and the answers the fake took. */
  readonly offers = new FakeOfferDesk();
  #sequence = 0;
  #purchases = 0;
  #url = '';

  private constructor(options: FakeDepopSiteOptions) {
    this.#pageSize = options.pageSize ?? 10;
    this.#defaultShipping =
      options.defaultShipping === undefined ? 'depop_shipping' : options.defaultShipping;
    this.#onSignInLink = options.onSignInLink;
    this.#boostByDefault = options.boostByDefault ?? false;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end(error instanceof Error ? error.message : 'error');
        }
      });
    });
  }

  static async start(port = 0, options: FakeDepopSiteOptions = {}): Promise<FakeDepopSite> {
    const site = new FakeDepopSite(options);
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

  /**
   * The cookie a seller's logged-in browser holds, as the app would hand it to Listora. Depop
   * usernames are letters, numbers, periods, and underscores, so any other character in `seller`
   * becomes an underscore (`e2e-seller` is signed in as `e2e_seller`).
   */
  issueSession(seller = DEFAULT_SELLER): SessionCookie {
    const token = randomBytes(16).toString('hex');
    this.#sessions.set(token, { seller: depopUsername(seller) });
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

  /** Every sign-in link the site emailed, oldest first (used ones included). */
  signInLinks(): string[] {
    return [...this.#signInLinks];
  }

  inject(rule: FakeDepopSiteFaultRule): void {
    this.#faults.push({ ...rule, remaining: rule.times ?? 1 });
  }

  clearFaults(): void {
    this.#faults.length = 0;
  }

  products(): FakeDepopProduct[] {
    return [...this.#products.values()].map((stored) => copy(stored.current));
  }

  product(slug: string): FakeDepopProduct | undefined {
    const stored = this.#products.get(slug);
    return stored === undefined ? undefined : copy(stored.current);
  }

  /** The products whose text carries Listora's line for this SKU (deleted ones included). */
  productsWithSku(sku: string): FakeDepopProduct[] {
    const line = new RegExp(`(^|\\n)SKU: ${sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\n|$)`);
    return this.products().filter((product) => line.test(product.description));
  }

  /** Lists a product directly, as the seller once did by hand; returns its slug. */
  seed(
    product: Partial<Omit<FakeDepopProduct, 'slug' | 'updatedAt'>> & {
      description: string;
      priceCents: number;
    },
  ): string {
    const seller = depopUsername(product.seller ?? DEFAULT_SELLER);
    const slug = this.#newSlug(seller, product.description);
    const now = new Date();
    this.#products.set(slug, {
      id: this.#sequence,
      current: {
        status: 'ONSALE',
        originalPriceCents: null,
        category: ['Women', 'Tops', 'T-shirts'],
        size: 'M',
        brand: null,
        condition: 'used_good',
        colours: [],
        materials: [],
        details: {},
        boosted: false,
        shipping: 'depop_shipping',
        photos: ['photo.jpg'],
        listedAt: now,
        soldAt: null,
        ...product,
        seller,
        slug,
        updatedAt: seconds(now),
      },
      previous: null,
      gone: false,
      purchaseId: product.status === 'PURCHASED' ? this.#newPurchaseId() : null,
    });
    return slug;
  }

  /**
   * A buyer buys the product: it is sold (a receipt on the sold items page), and its last change
   * time is the sale's, as a sold product can't be changed any more.
   */
  sell(
    slug: string,
    soldAt = new Date(),
    shipping?: FakeDepopShipping,
    purchase: FakeDepopPurchase = {},
  ): void {
    this.#purchase([slug], soldAt, this.#newPurchaseId(), shipping, purchase);
  }

  /** A buyer buys several products in one purchase (a bundle), each for what it says. */
  sellBundle(lines: readonly { slug: string; paidCents: number }[], soldAt = new Date()): number {
    const purchaseId = this.#newPurchaseId();
    for (const line of lines) {
      this.#purchase([line.slug], soldAt, purchaseId, undefined, { paidCents: line.paidCents });
    }
    return purchaseId;
  }

  /** The purchase ships (or is canceled), as its receipt then says. */
  purchaseStatus(slug: string, status: FakeDepopPurchaseStatus): void {
    this.#stored(slug).purchaseStatus = status;
  }

  #purchase(
    slugs: readonly string[],
    soldAt: Date,
    purchaseId: number,
    shipping: FakeDepopShipping | undefined,
    purchase: FakeDepopPurchase,
  ): void {
    for (const slug of slugs) {
      const stored = this.#stored(slug);
      this.#change(stored, { status: 'PURCHASED', soldAt });
      stored.current.updatedAt = seconds(soldAt);
      stored.purchaseId = purchaseId;
      stored.paidCents = purchase.paidCents ?? stored.current.priceCents;
      stored.purchaseStatus = purchase.status ?? 'shipping_pending';
      if (shipping !== undefined) stored.shipping = shipping;
    }
  }

  /** The seller marks the product as sold (it sold somewhere else): no receipt. */
  markAsSold(slug: string, at = new Date()): void {
    const stored = this.#stored(slug);
    this.#change(stored, { status: 'MARKED_AS_SOLD' });
    stored.current.updatedAt = seconds(at);
  }

  /** The sale's purchase id (its receipt's), once it sold. */
  purchaseIdOf(slug: string): number | null {
    return this.#stored(slug).purchaseId;
  }

  /**
   * Depop deletes the product for good: its page answers 410 Gone, as Depop's did for a listing
   * Listora deleted (2026-10-27).
   */
  gone(slug: string): void {
    const stored = this.#stored(slug);
    if (stored.current.status === 'ONSALE') this.#change(stored, { status: 'DELETED' });
    stored.gone = true;
  }

  /** Depop no longer serves the product at all: its page is a plain 404. */
  forget(slug: string): void {
    this.#products.delete(slug);
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
    const record: FakeDepopSiteRequest = {
      method,
      path: url.pathname,
      action: null,
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

    if (url.pathname === '/login/') {
      if (method === 'POST') {
        // The seller logs in by hand, as on the app's Link accounts screen in development: any
        // username with a password starts a session as that seller.
        const form = await readForm(request);
        const seller = form.text('username');
        if (seller !== '' && form.text('password') !== '') {
          const { value } = this.issueSession(seller);
          send({
            status: 303,
            headers: {
              location: '/sellinghub/',
              'set-cookie': `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
            },
          });
          return;
        }
      }
      send({ status: 200, body: loginPage() });
      return;
    }
    if (url.pathname === '/login/email-link/' && method === 'POST') {
      // Depop's passwordless sign-in: the seller asks for a link, which arrives by email. Here
      // it is kept (and handed to `onSignInLink`) instead.
      const form = await readForm(request);
      const email = form.text('email');
      if (email === '') {
        send({ status: 200, body: loginPage() });
        return;
      }
      const token = randomBytes(16).toString('hex');
      this.#signInTokens.set(token, email.split('@')[0] ?? email);
      const link = new URL(`/login/magic-link/?token=${token}`, this.#url).href;
      this.#signInLinks.push(link);
      this.#onSignInLink?.(link);
      send({ status: 200, body: emailLinkSentPage() });
      return;
    }
    if (url.pathname === '/login/magic-link/') {
      // The emailed link signs in once, in the browser that opens it.
      const token = url.searchParams.get('token') ?? '';
      const seller = this.#signInTokens.get(token);
      if (seller === undefined) {
        send({ status: 400, body: expiredLinkPage() });
        return;
      }
      this.#signInTokens.delete(token);
      const { value } = this.issueSession(seller);
      send({
        status: 303,
        headers: {
          location: '/sellinghub/',
          'set-cookie': `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
        },
      });
      return;
    }
    if (url.pathname === '/login/verify/') {
      send({ status: 200, body: verifyPage() });
      return;
    }
    if (/^\/photos\/[\w.-]+\.jpg$/.test(url.pathname)) {
      record.status = 200;
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      response.end(PHOTO_BYTES);
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
    if (route?.api === true) {
      // Depop's web API: the session's token as the bearer token, as its pages send it.
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
      const apiSession = bearer === undefined ? undefined : this.#sessions.get(bearer);
      if (apiSession === undefined || bearer === undefined) {
        send(json(401, { message: 'Unauthorized' }));
        return;
      }
      const fault = this.#takeFault(route.action);
      record.fault = fault?.type ?? null;
      send(await this.#route(route, url, request, apiSession, bearer, fault));
      return;
    }
    const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
    const session = token === undefined ? undefined : this.#sessions.get(token);
    if (session === undefined || token === undefined) {
      send(redirect('/login/'));
      return;
    }
    if (route === null) {
      send(notFound());
      return;
    }
    const fault = this.#takeFault(route.action);
    record.fault = fault?.type ?? null;
    const reply = await this.#route(route, url, request, session, token, fault);
    // Depop's pages keep the session's API token where their own scripts read it.
    send({
      ...reply,
      headers: { ...reply.headers, 'set-cookie': `${TOKEN_COOKIE}=${token}; Path=/; SameSite=Lax` },
    });
  }

  async #route(
    route: Route,
    url: URL,
    request: IncomingMessage,
    session: Session,
    token: string,
    fault: FakeDepopSiteFault | undefined,
  ): Promise<Reply> {
    switch (fault?.type) {
      case 'bot_check':
        return { status: 403, body: botCheckPage() };
      case 'login_challenge':
        return redirect('/login/verify/');
      case 'session_expired':
        this.#sessions.delete(token);
        return redirect('/login/');
      case 'rate_limited':
        return {
          status: 429,
          headers:
            fault.retryAfterSeconds === undefined
              ? {}
              : { 'retry-after': String(fault.retryAfterSeconds) },
          body: plainPage('Too many requests | Depop', '<p>Slow down a little.</p>'),
        };
      case 'redesigned':
        return { status: 200, body: plainPage('Depop', '<main><h1>Something new</h1></main>') };
      case 'captcha':
      case 'server_error':
      case 'reject':
      case 'slow':
      case 'stale_read':
      case undefined:
        break;
    }

    const form = route.method === 'POST' ? await readForm(request) : null;
    if (fault?.type === 'reject' && form !== null) {
      return this.#refused(
        fault.message,
        route.slug === null ? null : this.#products.get(route.slug),
        session,
      );
    }
    const apply = (): Reply => this.#apply(route, url, form, session, fault);
    if (fault?.type === 'server_error') {
      if (fault.afterApply === true) apply();
      return { status: 500, body: plainPage('Something went wrong | Depop', '<p>Error.</p>') };
    }
    if (fault?.type === 'slow') {
      const early = fault.afterApply ? apply() : undefined;
      await delay(fault.delayMs, this.#timers);
      return early ?? apply();
    }
    const reply = apply();
    if (fault?.type === 'captcha' && reply.body !== undefined) {
      // A CAPTCHA widget over the page Depop served.
      return { ...reply, body: reply.body.replace('<body>', `<body>${captchaWidget()}`) };
    }
    return reply;
  }

  #apply(
    route: Route,
    url: URL,
    form: SubmittedForm | null,
    session: Session,
    fault: FakeDepopSiteFault | undefined,
  ): Reply {
    switch (route.action) {
      case 'health':
        return { status: 200, body: hubPage(session.seller) };
      case 'form':
        if (route.slug === null) {
          return {
            status: 200,
            body: listingFormPage({
              product: null,
              shipping: this.#defaultShipping,
              message: null,
              viewer: session.seller,
              boosted: this.#boostByDefault,
            }),
          };
        }
        return this.#owned(route.slug, session, (stored) =>
          onSale(stored)
            ? {
                status: 200,
                body: listingFormPage({
                  product: stored.current,
                  shipping: null,
                  message: null,
                  viewer: session.seller,
                }),
              }
            : // Depop shows no edit page for a listing that is not for sale: its page instead.
              redirect(`/products/${stored.current.slug}/`),
        );
      case 'create': {
        const fields = listingFields(form, null);
        if (typeof fields === 'string') return this.#refused(fields, null, session);
        const slug = this.#newSlug(session.seller, fields.description);
        const now = new Date();
        this.#products.set(slug, {
          id: this.#sequence,
          current: {
            slug,
            seller: session.seller,
            status: 'ONSALE',
            originalPriceCents: null,
            ...fields,
            listedAt: now,
            updatedAt: seconds(now),
            soldAt: null,
          },
          previous: null,
          gone: false,
          purchaseId: null,
        });
        // "Post and add another" opens a new empty form; otherwise Depop's Done page, which
        // doesn't name the new listing.
        return redirect(
          form?.text('postAnother') === '' ? '/products/create/done/' : '/products/create/',
        );
      }
      case 'done':
        return { status: 200, body: donePage(session.seller) };
      case 'update':
        return this.#owned(route.slug, session, (stored) => {
          if (!onSale(stored)) {
            return this.#refused('Only listings on sale can be edited.', stored, session);
          }
          const fields = listingFields(form, stored.current);
          if (typeof fields === 'string') return this.#refused(fields, stored, session);
          this.#change(stored, fields);
          return redirect(`/products/${stored.current.slug}/`);
        });
      case 'delete':
        return this.#owned(route.slug, session, (stored) => {
          if (onSale(stored)) this.#change(stored, { status: 'DELETED' });
          return redirect(`/products/${stored.current.slug}/`);
        });
      case 'read': {
        const stored = this.#products.get(route.slug ?? '');
        if (route.api === true) {
          // The seller's own product, as the edit page loads it; Depop answers 404 for one it
          // deleted for good, and for another seller's.
          // (The fake keeps a deleted product readable, as the shared suite reads an ended
          // listing; Depop's own page answers 410 for one, which a read sees first.)
          if (stored === undefined || stored.gone || stored.current.seller !== session.seller) {
            return json(404, { message: 'Product not found' });
          }
          const shown =
            fault?.type === 'stale_read' && stored.previous !== null
              ? stored.previous
              : stored.current;
          return json(200, editListingData(shown, stored.id, this.url));
        }
        if (stored === undefined) return notFound();
        if (stored.gone) return { status: 410, body: gonePage() };
        const shown =
          fault?.type === 'stale_read' && stored.previous !== null
            ? stored.previous
            : stored.current;
        return {
          status: 200,
          body: productPage({
            product: shown,
            id: stored.id,
            others: this.#forSale(shown.seller).filter((other) => other.slug !== shown.slug),
            viewer: session.seller,
            origin: this.#url,
          }),
        };
      }
      case 'listings': {
        // The seller's own listings, newest first, a page at a time with a cursor.
        const filter = url.searchParams.get('statusFilter');
        const rows =
          filter === 'sold'
            ? [...this.#products.values()]
                .filter((stored) => stored.current.seller === session.seller)
                .filter(
                  (stored) =>
                    stored.current.status === 'PURCHASED' ||
                    stored.current.status === 'MARKED_AS_SOLD',
                )
                .map((stored) => copy(stored.current))
                .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
            : this.#forSale(session.seller);
        const limit = Math.max(1, Number(url.searchParams.get('limit') ?? '24') || 24);
        const start = Math.max(0, Number(url.searchParams.get('cursor') ?? '0') || 0);
        const size = Math.min(limit, this.#pageSize);
        const page = rows.slice(start, start + size);
        const end = start + size >= rows.length;
        return json(200, {
          meta: { cursor: end ? null : String(start + size), end },
          products: page.map((product) =>
            shopProductData(product, this.#idOf(product.slug), this.#url),
          ),
        });
      }
      case 'offers':
        return route.slug === null
          ? this.#offerProducts(url)
          : this.#productOffers(Number(route.slug), url);
      case 'offer': {
        const id = route.slug ?? '';
        const offer = this.offers.get(id);
        return {
          status: offer === undefined ? 404 : 200,
          body: plainPage(
            'Offer | Depop',
            fakeOfferPageBody(offer, `/sellinghub/offers/${id}`, url.searchParams.get('confirm')),
          ),
        };
      }
      case 'answer_offer': {
        const id = route.slug ?? '';
        const answered = this.offers.answer(
          id,
          form?.text('action') ?? '',
          form?.text('counter') ?? null,
        );
        if (answered.status === 303) return redirect(`/sellinghub/offers/${id}/`);
        return {
          status: answered.status,
          body: plainPage(
            'Offer | Depop',
            fakeOfferPageBody(
              this.offers.get(id),
              `/sellinghub/offers/${id}`,
              null,
              answered.message,
            ),
          ),
        };
      }
      case 'receipts': {
        // The seller's purchases, newest first, a page at a time, as Depop's receipts list them
        // (the fields Listora reads, with invented values; read 2026-10-28).
        const purchases = this.#purchasesOf(session.seller);
        const limit = Math.max(1, Number(url.searchParams.get('limit') ?? '24') || 24);
        const after = url.searchParams.get('after');
        const start = after === null ? 0 : Math.max(0, Number(after.replace(/^r/, '')) || 0);
        const page = purchases.slice(start, start + Math.min(limit, this.#pageSize));
        const end = start + page.length;
        return json(200, {
          objects: page.map((lines) => receiptData(lines, this.#idOf.bind(this))),
          page_info: {
            has_more: end < purchases.length,
            first: `r${String(start)}`,
            last: `r${String(end)}`,
          },
        });
      }
      case 'receipt': {
        const lines = this.#purchasesOf(session.seller).find(
          (purchase) => String(purchase[0]?.purchaseId) === route.slug,
        );
        if (lines === undefined) return json(404, { message: 'Receipt not found' });
        return json(200, receiptDetailData(lines, this.#idOf.bind(this)));
      }
      case 'sold': {
        const sales = [...this.#products.values()]
          .flatMap((stored) =>
            stored.current.seller === session.seller &&
            stored.current.status === 'PURCHASED' &&
            stored.purchaseId !== null
              ? [
                  {
                    purchaseId: stored.purchaseId,
                    soldAt: stored.current.soldAt ?? stored.current.updatedAt,
                  },
                ]
              : [],
          )
          .sort((a, b) => b.soldAt.getTime() - a.soldAt.getTime());
        return { status: 200, body: soldItemsPage(session.seller, sales) };
      }
    }
  }

  /** The seller's purchases, newest first: each one's products (a bundle has several). */
  #purchasesOf(seller: string): StoredProduct[][] {
    const byPurchase = new Map<number, StoredProduct[]>();
    for (const stored of this.#products.values()) {
      if (stored.current.seller !== seller || stored.purchaseId === null) continue;
      if (stored.current.status !== 'PURCHASED') continue;
      byPurchase.set(stored.purchaseId, [...(byPurchase.get(stored.purchaseId) ?? []), stored]);
    }
    return [...byPurchase.values()].sort(
      (a, b) => (b[0]?.current.soldAt?.getTime() ?? 0) - (a[0]?.current.soldAt?.getTime() ?? 0),
    );
  }

  /** The seller's products for sale, newest first. */
  #forSale(seller: string): FakeDepopProduct[] {
    return [...this.#products.values()]
      .filter((stored) => stored.current.seller === seller && onSale(stored))
      .sort((a, b) => b.current.listedAt.getTime() - a.current.listedAt.getTime() || b.id - a.id)
      .map((stored) => copy(stored.current));
  }

  /**
   * The products with offers (`offers/me/products/`), 10 a page with `after=` as Depop's are
   * (docs/features/offers.md): the seller's own offers to likers count too.
   */
  #offerProducts(url: URL): Reply {
    const slugs = [...new Set(this.offers.all().map((offer) => offer.listingId))];
    const start = Number(url.searchParams.get('after') ?? '0');
    const page = slugs.slice(start, start + OFFER_PAGE);
    const end = start + OFFER_PAGE >= slugs.length;
    return json(200, {
      objects: page.map((slug) => {
        const stored = this.#products.get(slug);
        return {
          id: this.#idOf(slug),
          slug,
          ...(stored === undefined ? {} : { description: stored.current.description }),
        };
      }),
      page_info: { has_more: !end, last: end ? null : String(start + OFFER_PAGE) },
    });
  }

  /** One product's offers (`products/<id>/offers/?active=`), as Depop's records name them. */
  #productOffers(id: number, url: URL): Reply {
    const active = url.searchParams.get('active') !== 'false';
    const slug = [...this.#products.entries()].find(([, stored]) => stored.id === id)?.[0];
    const offers = this.offers
      .all()
      .filter((offer) => offer.listingId === slug)
      .filter((offer) => (offer.status === 'pending' || offer.status === 'countered') === active);
    return json(200, {
      objects: offers.map((offer) => ({
        offer_id: offer.id,
        offer_value: { amount: (offer.amountCents / 100).toFixed(2), currency: 'USD' },
        offer_display_status: this.offerStatusOverride ?? depopStatus(offer),
        expires_at: offer.expiresAt,
        created_at: offer.createdAt,
        can_make_counter_offer: offer.status === 'pending',
        offerer: { username: offer.buyer },
      })),
      page_info: { has_more: false, last: null },
    });
  }

  #idOf(slug: string): number {
    return this.#products.get(slug)?.id ?? 0;
  }

  #owned(slug: string | null, session: Session, act: (stored: StoredProduct) => Reply): Reply {
    const stored = slug === null ? undefined : this.#products.get(slug);
    if (stored?.current.seller !== session.seller) return notFound();
    return act(stored);
  }

  /** The form again, with Depop's message; nothing applied. */
  #refused(message: string, stored: StoredProduct | undefined | null, session: Session): Reply {
    return {
      status: 422,
      body: listingFormPage({
        product: stored?.current ?? null,
        shipping: this.#defaultShipping,
        message,
        viewer: session.seller,
      }),
    };
  }

  #stored(slug: string): StoredProduct {
    const stored = this.#products.get(slug);
    if (stored === undefined) throw new Error(`no product ${slug}`);
    return stored;
  }

  #change(stored: StoredProduct, change: Partial<FakeDepopProduct>): void {
    stored.previous = copy(stored.current);
    // Depop's change time; automated changes are seconds apart, so it always grows.
    const updatedAt = new Date(
      Math.max(seconds(new Date()).getTime(), stored.current.updatedAt.getTime() + 1_000),
    );
    stored.current = { ...stored.current, ...change, updatedAt };
  }

  /** Depop's slugs: the seller's username, then the first words of the listing. */
  #newSlug(seller: string, description: string): string {
    this.#sequence += 1;
    const words = description
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== '')
      .slice(0, 4);
    const slug = [seller, ...words, this.#sequence.toString(36)].join('-');
    if (!DEPOP_SLUG.test(slug)) throw new Error(`the fake made an invalid slug ${slug}`);
    return slug;
  }

  #newPurchaseId(): number {
    this.#purchases += 1;
    return 7_000_000 + this.#purchases;
  }

  #takeFault(action: FakeDepopSiteAction): FakeDepopSiteFault | undefined {
    const rule = this.#faults.find(
      (candidate) => candidate.action === action && candidate.remaining > 0,
    );
    if (rule === undefined) return undefined;
    rule.remaining -= 1;
    return rule.fault;
  }
}

// Routing -------------------------------------------------------------------------------------

function matchRoute(method: string, path: string): Route | null {
  const get = method === 'GET';
  const post = method === 'POST';
  if (get && path === '/sellinghub/') return { method, action: 'health', slug: null };
  if (get && path === '/api/v1/shop/products/') {
    return { method, action: 'listings', slug: null, api: true };
  }
  const own = /^\/presentation\/api\/v1\/products\/by-slug\/([^/]+)\/edit-listing\/$/.exec(
    path,
  )?.[1];
  if (get && own !== undefined) return { method, action: 'read', slug: decoded(own), api: true };
  if (get && path === '/sellinghub/sold-items/') return { method, action: 'sold', slug: null };
  if (get && path === '/presentation/api/v1/offers/me/products/') {
    return { method, action: 'offers', slug: null, api: true };
  }
  const productOffers = /^\/presentation\/api\/v1\/products\/(\d+)\/offers\/$/.exec(path)?.[1];
  if (get && productOffers !== undefined) {
    return { method, action: 'offers', slug: productOffers, api: true };
  }
  const offer = /^\/sellinghub\/offers\/([\w-]+)\/?(answer)?$/.exec(path);
  if (offer?.[1] !== undefined) {
    if (get && offer[2] === undefined) return { method, action: 'offer', slug: offer[1] };
    if (post && offer[2] !== undefined) return { method, action: 'answer_offer', slug: offer[1] };
  }
  if (get && path === '/presentation/api/v1/receipts/') {
    return { method, action: 'receipts', slug: null, api: true };
  }
  const receipt = /^\/presentation\/api\/v1\/receipts\/(\d+)\/$/.exec(path)?.[1];
  if (get && receipt !== undefined) return { method, action: 'receipt', slug: receipt, api: true };
  if (path === '/products/create/') {
    if (get) return { method, action: 'form', slug: null };
    if (post) return { method, action: 'create', slug: null };
  }
  if (get && path === '/products/create/done/') return { method, action: 'done', slug: null };
  const edit = /^\/products\/edit\/([^/]+)\/(delete)?$/.exec(path);
  const slug = edit?.[1] === undefined ? undefined : decoded(edit[1]);
  if (slug !== undefined) {
    if (get && edit?.[2] === undefined) return { method, action: 'form', slug };
    if (post && edit?.[2] === undefined) return { method, action: 'update', slug };
    if (post && edit?.[2] === 'delete') return { method, action: 'delete', slug };
    return null;
  }
  const product = /^\/products\/([^/]+)\/$/.exec(path)?.[1];
  if (get && product !== undefined) return { method, action: 'read', slug: decoded(product) };
  return null;
}

/** One page of products with offers. */
const OFFER_PAGE = 10;

/** An offer's `offer_display_status`, as Depop names them (docs/features/offers.md). */
function depopStatus(offer: FakeOffer): string {
  if (offer.sentBySeller === true) return 'SENT_PRIVATE_OFFER';
  switch (offer.status) {
    case 'pending':
      return 'RECEIVED';
    case 'accepted':
      return 'ACCEPTED';
    case 'declined':
      return 'DECLINED';
    case 'countered':
      return 'COUNTER_OFFER_SENT';
  }
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function notFound(): Reply {
  return { status: 404, body: notFoundPage() };
}

function onSale(stored: StoredProduct): boolean {
  return stored.current.status === 'ONSALE' && !stored.gone;
}

/**
 * A Depop username for `name`: Depop's take letters, numbers, periods, and underscores, and the
 * fake keeps them lowercase, as product slugs have them.
 */
function depopUsername(name: string): string {
  const username = name
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 30);
  return USERNAME.test(username) ? username : DEFAULT_SELLER;
}

// Forms ---------------------------------------------------------------------------------------

type ListingFields = Pick<
  FakeDepopProduct,
  | 'description'
  | 'priceCents'
  | 'category'
  | 'size'
  | 'brand'
  | 'condition'
  | 'colours'
  | 'materials'
  | 'details'
  | 'boosted'
  | 'shipping'
  | 'photos'
>;

/** The form's fields, or Depop's message for the first problem. */
function listingFields(
  form: SubmittedForm | null,
  existing: FakeDepopProduct | null,
): ListingFields | string {
  const text = (name: string): string => form?.text(name) ?? '';
  // Browsers send a textarea's line breaks as CRLF.
  const description = text('description').replaceAll('\r\n', '\n');
  const price = text('price');
  const photos = form?.fileNames('photos') ?? [];
  // The category picker sends the product type's whole path ("Men > Tops > T-shirts").
  const category = text('category')
    .split(' > ')
    .filter((name) => name !== '');
  const leaf = fakeDepopTree().find((entry) => entry.path.join(' > ') === category.join(' > '));
  const picks = (name: string) =>
    text(name)
      .split('|')
      .filter((value) => value !== '');
  const size = text('size');
  const brand = text('brand');
  const condition = text('condition');
  const shipping = text('shipping');
  const keptPhotos = photos.length === 0 && existing !== null ? existing.photos : photos;
  if (keptPhotos.length === 0) return 'Add at least 1 photo.';
  if (keptPhotos.length > LIMITS.photos) return 'You can add up to 8 photos.';
  if (description === '') return 'Add a description.';
  if (description.length > LIMITS.description) {
    return 'Your description can be up to 1000 characters.';
  }
  if (DEPOP_EMAIL_ADDRESS.test(description)) {
    return 'Email addresses aren’t allowed in descriptions.';
  }
  if ((description.match(/#[^\s#]+/g)?.length ?? 0) > LIMITS.hashtags) {
    return 'You can add up to 5 hashtags.';
  }
  if (leaf === undefined) return 'Choose a category.';
  if (leaf.sizes.length > 0 && !leaf.sizes.includes(size)) return 'Choose a size.';
  if (
    brand !== '' &&
    brand !== FAKE_DEPOP_OTHER_BRAND &&
    !(FAKE_DEPOP_BRANDS as readonly string[]).includes(brand)
  ) {
    return 'Choose a brand from the list.';
  }
  if (!Object.keys(DEPOP_CONDITION_LABELS).includes(condition)) return 'Choose the condition.';
  if (!Object.keys(FAKE_DEPOP_SHIPPING).includes(shipping)) {
    return 'Choose how you’ll ship this item.';
  }
  const amount = /^(\d+)(?:\.(\d{1,2}))?$/.exec(price);
  if (amount?.[1] === undefined) return 'Enter a price.';
  const cents = Number(amount[1]) * 100 + Number((amount[2] ?? '0').padEnd(2, '0'));
  if (cents < LIMITS.minCents) return 'The price must be at least $1.00.';
  return {
    description,
    priceCents: cents,
    category,
    size: leaf.sizes.length === 0 ? null : size,
    brand: brand === '' ? null : brand,
    condition,
    colours: picks('colour'),
    materials: leaf.material ? picks('material') : [],
    details: Object.fromEntries(
      FAKE_DEPOP_DETAILS.flatMap((detail) => {
        const offered = detail.name === 'style' || leaf.attributes.includes(detail.attribute);
        const values = offered ? picks(`detail:${detail.name}`) : [];
        return values.length === 0 ? [] : [[detail.name, values]];
      }),
    ),
    boosted: form?.text('boost') === 'on',
    shipping,
    photos: keptPhotos,
  };
}

// Page data -----------------------------------------------------------------------------------

function priceData(cents: number): { priceAmount: string; currencyName: string } {
  return { priceAmount: priceAmount(cents), currencyName: 'USD' };
}

/** A product as the API's list of the seller's own listings has it (pages/api.ts). */
function shopProductData(
  product: FakeDepopProduct,
  id: number,
  origin: string,
): Record<string, unknown> {
  return {
    id,
    slug: product.slug,
    status: product.status,
    description: product.description,
    price: { ...priceData(product.priceCents), nationalShippingCost: '1.99' },
    sizes: product.size === null ? [] : [product.size],
    category: product.category[1],
    // Each picture's sizes, as the list shows them (read 2026-10-28).
    pictures: product.photos.map((name, index) => [
      { id: index, width: 640, height: 640, url: `${origin}/media/${fakeMediaName(name)}.jpg` },
    ]),
    dateCreated: product.listedAt.toISOString(),
    dateUpdated: product.updatedAt.toISOString(),
  };
}

/** Depop's department names as the edit data's `categories` still name them. */
const FORMER_DEPARTMENTS: Readonly<Record<string, string>> = {
  menswear: 'Menswear',
  womenswear: 'Womenswear',
  kidswear: 'Kidswear',
  'everything-else': 'Everything else',
};

/** The edit data's `gender` by Depop's department. */
const GENDERS: Readonly<Record<string, string>> = { menswear: 'male', womenswear: 'female' };

/**
 * The seller's own product as the edit page loads it from the API (pages/api.ts), with its
 * photos as Listora's import reads them (pages/listing-details.ts): each picture's sizes, the
 * images served from the fake's own image CDN (`/media/`, fake-photos.ts). As on Depop, its
 * category is Depop's ids (`gender`, `group`, `product_type`) beside the names `categories`
 * shows, which stop at the department and category; its brand is Depop's slug beside the
 * brand's name ("Other" for none); a marked-down product's pricing has both prices.
 */
function editListingData(
  product: FakeDepopProduct,
  id: number,
  origin: string,
): Record<string, unknown> {
  const original = product.originalPriceCents;
  const reduced = original !== null && original > product.priceCents;
  const [department, group, productType] = allDepopCategories().find(
    (entry) => entry.path.join('>') === product.category.join('>'),
  )?.ids ?? [null, null, null];
  return {
    id,
    status: `STATUS_${product.status}`,
    categories:
      department === null
        ? product.category
        : [FORMER_DEPARTMENTS[department] ?? department, product.category[1]],
    ...(department === null
      ? {}
      : {
          ...(GENDERS[department] === undefined ? {} : { gender: GENDERS[department] }),
          is_kids: department === 'kidswear',
          group,
          product_type: productType,
        }),
    description: product.description,
    // Depop's own, to the microsecond.
    updated_at: product.updatedAt.toISOString().replace('Z', '123Z'),
    created_at: product.listedAt.toISOString(),
    pricing: {
      final_price_key: reduced ? 'discounted_price' : 'original_price',
      currency: 'USD',
      currency_name: 'USD',
      is_reduced: reduced,
      original_price: price(reduced ? original : product.priceCents),
      ...(reduced
        ? {
            discount_percentage: Math.round(100 - (product.priceCents / original) * 100),
            discounted_price: price(product.priceCents),
          }
        : {}),
    },
    slug: product.slug,
    is_boosted: product.boosted,
    condition: product.condition,
    colour: product.colours.map((colour) => colour.toLowerCase()),
    brand: product.brand === null ? 'unbranded' : brandSlug(product.brand),
    brand_name: product.brand ?? 'Other',
    pictures: product.photos.map((name, index) => [
      {
        id: index * 2,
        width: 320,
        height: 320,
        url: `${origin}/media/${fakeMediaName(name)}-s.jpg`,
      },
      {
        id: index * 2 + 1,
        width: 1280,
        height: 1280,
        url: `${origin}/media/${fakeMediaName(name)}.jpg`,
      },
    ]),
  };
}

/** A price as Depop's pricing gives one. */
function price(cents: number): Record<string, unknown> {
  const amount = priceAmount(cents);
  return { total_price: amount, price_breakdown: { price: { amount } } };
}

/** Depop's slug of a brand's name (`Hollister Co.` is `hollister-co`). */
function brandSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function json(status: number, body: unknown): Reply {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function seconds(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

function copy(product: FakeDepopProduct): FakeDepopProduct {
  return {
    ...product,
    category: [...product.category],
    colours: [...product.colours],
    materials: [...product.materials],
    details: Object.fromEntries(
      Object.entries(product.details).map(([name, values]) => [name, [...values]]),
    ),
    photos: [...product.photos],
    listedAt: new Date(product.listedAt),
    updatedAt: new Date(product.updatedAt),
    soldAt: product.soldAt === null ? null : new Date(product.soldAt),
  };
}

/**
 * One purchase as Depop's receipts list shows it: the fields Listora reads (its id, status,
 * time, what the buyer paid for the items and what the seller is paid, and each line's
 * product), plus the buyer's first name and the parcel's tracking for Pack check. Invented
 * values only.
 */
function receiptData(
  lines: readonly StoredProduct[],
  idOf: (slug: string) => number,
): Record<string, unknown> {
  const first = lines[0];
  if (first === undefined) throw new Error('a purchase has a product');
  const paid = lines.reduce((total, line) => total + (line.paidCents ?? 0), 0);
  return {
    purchase_id: first.purchaseId,
    status: first.purchaseStatus ?? 'shipping_pending',
    sold_timestamp: (first.current.soldAt ?? first.current.updatedAt).toISOString(),
    is_bundle: lines.length > 1,
    currency: 'USD',
    items_amount: priceAmount(paid),
    // What the seller is paid: the fake's Depop keeps 10%.
    seller_amount: priceAmount(paid - Math.round(paid / 10)),
    buyer: { first_name: first.shipping?.buyerFirstName ?? 'Buyer' },
    line_items: lines.map((line, index) => ({
      id: 100 + index,
      product_id: idOf(line.current.slug),
      description: line.current.description,
      picture_url: 'https://media-photos.depop.com/fake/P0.jpg',
    })),
    parcels: [
      {
        parcel_status: first.purchaseStatus === 'shipped' ? 'IN_TRANSIT' : 'AWAITING_SHIPPING',
        tracking:
          first.shipping?.trackingNumber === undefined || first.shipping.trackingNumber === null
            ? null
            : { reference: first.shipping.trackingNumber },
      },
    ],
  };
}

/** One purchase as its own receipt shows it: each line's product, slug, and what it sold for. */
function receiptDetailData(
  lines: readonly StoredProduct[],
  idOf: (slug: string) => number,
): Record<string, unknown> {
  return {
    purchase_id: lines[0]?.purchaseId,
    lines: lines.map((line) => ({
      product_id: idOf(line.current.slug),
      slug: line.current.slug,
      product_amount: priceAmount(line.paidCents ?? 0),
      original_price: priceAmount(line.current.priceCents),
    })),
  };
}
