/**
 * The fake Depop site: a local web app with the pages and flows of Depop's website that the
 * Depop automation adapter uses (docs/features/depop-automation.md), for its development and
 * tests. No test sends traffic to Depop. It mirrors the adapter's model of Depop: the same
 * paths, the same form elements and embedded page data (`script#__NEXT_DATA__`), the sell form's
 * level-by-level category picker, size lists, brand search, and validation, the edit page's
 * Delete with the browser's confirmation dialog, the selling hub's listings and sold items with
 * pagination, and Depop's checks (a bot-check page, a CAPTCHA, a login code, a logged-out
 * session), with fault injection for each.
 *
 *   GET  /login/                       the login page (a password field: no session needs it)
 *   POST /login/                       log in by hand: any username and password; sets the session cookie
 *   POST /login/email-link/            email me a sign-in link: "sends" a one-time link (`signInLinks()`)
 *   GET  /login/magic-link/?token=     the emailed link: signs in once and sets the session cookie
 *   GET  /login/verify/                a login code step
 *   GET  /sellinghub/                  the selling hub ([data-testid="sellingHub"])
 *   GET  /products/create/             the sell form; POST lists (multipart, photos)
 *   GET  /products/:slug/              a product's page (its data: text, price, status, change)
 *   GET  /products/edit/:slug/         the edit form; POST saves it
 *   POST /products/edit/:slug/delete   delete (after the page's confirmation dialog)
 *   GET  /sellinghub/selling/          the seller's listings for sale; `?page=N`, 10 a page
 *   GET  /sellinghub/sold-items/       the seller's sold items; `?page=N`, 10 a page
 *   GET  /photos/<name>.jpg            a photo, standing in for Listora's image CDN (no session)
 *
 * Every page except the login pages and photos needs the session cookie; without a valid one it
 * redirects to the login page. A product's change time grows by at least a second with every
 * change (automated changes are seconds apart), so it serves as a revision; a stale read serves
 * the product as it was before its latest change. A deleted product stays readable with the
 * status `DELETED`; an unknown slug is a plain 404.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SessionCookie } from '@listora/connections';
import { DEPOP_EMAIL_ADDRESS } from '@listora/shared';

import {
  cookieValue,
  delay,
  escape,
  readForm,
  redirect,
  type Reply,
  type SubmittedForm,
} from '../../fake-site/http.ts';
import { mappedDepopCategories, type DepopSizeKind } from '../categories.ts';
import { DEPOP_CONDITION_LABELS } from '../conditions.ts';
import { DEPOP_SLUG } from '../site.ts';

export type FakeDepopSiteAction =
  'create' | 'update' | 'delete' | 'read' | 'listings' | 'sold' | 'health' | 'form';

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

/** Depop's product statuses, as its pages embed them. */
export type FakeDepopStatus = 'ONSALE' | 'SOLD' | 'DELETED';

export interface FakeDepopProduct {
  slug: string;
  /** The seller whose session listed it; the selling hub shows only their own. */
  seller: string;
  status: FakeDepopStatus;
  /** The whole listing text, as the form's description field got it. */
  description: string;
  priceCents: number;
  /** Department, category, product type. */
  category: string[];
  size: string | null;
  brand: string | null;
  condition: string;
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
}

/** The brands Depop's brand search offers (a sample of its list). */
export const FAKE_DEPOP_BRANDS = [
  "Levi's",
  'Nike',
  'adidas',
  'Carhartt',
  'Dr. Martens',
  'Patagonia',
  'Ralph Lauren',
  'Stüssy',
  'The North Face',
  'Urban Outfitters',
  'Zara',
  'Converse',
  'Vans',
  'Free People',
] as const;

/** The shipping choices of the form. */
export const FAKE_DEPOP_SHIPPING = {
  depop_shipping: 'Depop Shipping',
  ship_yourself: 'Ship it yourself',
} as const;

const SIZES: Readonly<Record<Exclude<DepopSizeKind, 'none'>, readonly string[]>> = {
  clothing: [
    'XXS',
    'XS',
    'S',
    'M',
    'L',
    'XL',
    'XXL',
    'XXXL',
    'One size',
    'US 00',
    ...Array.from({ length: 25 }, (_, index) => `US ${String(index)}`),
    ...Array.from({ length: 27 }, (_, index) => `W${String(24 + index)}`),
  ],
  shoes: Array.from({ length: 21 }, (_, index) => {
    const size = 5 + index / 2;
    return `US ${Number.isInteger(size) ? String(size) : `${String(Math.floor(size))}.5`}`;
  }),
};

interface StoredProduct {
  current: FakeDepopProduct;
  previous: FakeDepopProduct | null;
}

interface Session {
  seller: string;
}

interface Route {
  method: 'GET' | 'POST';
  action: FakeDepopSiteAction;
  slug: string | null;
}

const SESSION_COOKIE = 'fake_depop_session';
const PHOTO_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const LIMITS = { description: 1_000, hashtags: 5, photos: 8, minCents: 100 };

export class FakeDepopSite {
  readonly #server: Server;
  readonly #pageSize: number;
  readonly #defaultShipping: string | null;
  readonly #products = new Map<string, StoredProduct>();
  readonly #sessions = new Map<string, Session>();
  /** Emailed sign-in links not used yet, by token: the seller each one signs in. */
  readonly #signInTokens = new Map<string, string>();
  readonly #signInLinks: string[] = [];
  readonly #onSignInLink: ((link: string) => void) | undefined;
  readonly #faults: (FakeDepopSiteFaultRule & { remaining: number })[] = [];
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly requests: FakeDepopSiteRequest[] = [];
  #sequence = 0;
  #url = '';

  private constructor(options: FakeDepopSiteOptions) {
    this.#pageSize = options.pageSize ?? 10;
    this.#defaultShipping =
      options.defaultShipping === undefined ? 'depop_shipping' : options.defaultShipping;
    this.#onSignInLink = options.onSignInLink;
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

  /** The cookie a seller's logged-in browser holds, as the app would hand it to Listora. */
  issueSession(seller = 'fake-seller'): SessionCookie {
    const token = randomBytes(16).toString('hex');
    this.#sessions.set(token, { seller });
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
    const seller = product.seller ?? 'fake-seller';
    const slug = this.#newSlug(seller, product.description);
    const now = new Date();
    this.#products.set(slug, {
      current: {
        status: 'ONSALE',
        category: ['Womenswear', 'Tops', 'T-shirts'],
        size: 'M',
        brand: null,
        condition: 'used_good',
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
    });
    return slug;
  }

  /** A buyer buys the product: it is sold (the sold items page). */
  sell(slug: string, soldAt = new Date()): void {
    this.#change(this.#stored(slug), { status: 'SOLD', soldAt });
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
      send({ status: 200, body: page('Log in | Depop', loginForm(), {}) });
      return;
    }
    if (url.pathname === '/login/email-link/' && method === 'POST') {
      // Depop's passwordless sign-in: the seller asks for a link, which arrives by email. Here
      // it is kept (and handed to `onSignInLink`) instead.
      const form = await readForm(request);
      const email = form.text('email');
      if (email === '') {
        send({ status: 200, body: page('Log in | Depop', loginForm(), {}) });
        return;
      }
      const token = randomBytes(16).toString('hex');
      this.#signInTokens.set(token, email.split('@')[0] ?? email);
      const link = new URL(`/login/magic-link/?token=${token}`, this.#url).href;
      this.#signInLinks.push(link);
      this.#onSignInLink?.(link);
      send({ status: 200, body: page('Check your email | Depop', emailLinkSent(), {}) });
      return;
    }
    if (url.pathname === '/login/magic-link/') {
      // The emailed link signs in once, in the browser that opens it.
      const token = url.searchParams.get('token') ?? '';
      const seller = this.#signInTokens.get(token);
      if (seller === undefined) {
        send({ status: 400, body: page('Link expired | Depop', expiredLink(), {}) });
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
      send({ status: 200, body: page('Check your email | Depop', verifyForm(), {}) });
      return;
    }
    if (/^\/photos\/[\w.-]+\.jpg$/.test(url.pathname)) {
      record.status = 200;
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      response.end(PHOTO_BYTES);
      return;
    }

    const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
    const session = token === undefined ? undefined : this.#sessions.get(token);
    const route = matchRoute(method, url.pathname);
    record.action = route?.action ?? null;
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
    send(await this.#route(route, url, request, session, token, fault));
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
          body: page('Too many requests | Depop', '<p>Slow down a little.</p>', {}),
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
      return refused(fault.message, route.slug === null ? null : this.#products.get(route.slug));
    }
    const apply = (): Reply => this.#apply(route, url, form, session, fault);
    if (fault?.type === 'server_error') {
      if (fault.afterApply === true) apply();
      return { status: 500, body: page('Something went wrong | Depop', '<p>Error.</p>', {}) };
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
        return {
          status: 200,
          body: page(
            'Selling hub | Depop',
            `<main data-testid="sellingHub"><h1>Selling hub</h1><p data-testid="sellerUsername">${escape(session.seller)}</p></main>`,
            { seller: { username: session.seller } },
          ),
        };
      case 'form':
        if (route.slug === null) {
          return {
            status: 200,
            body: page('Sell | Depop', listingForm(null, this.#defaultShipping), {}),
          };
        }
        return this.#owned(route.slug, session, (stored) =>
          stored.current.status === 'ONSALE'
            ? {
                status: 200,
                body: page('Edit listing | Depop', listingForm(stored.current, null), {}),
              }
            : redirect(`/products/${stored.current.slug}/`),
        );
      case 'create': {
        const fields = listingFields(form, null);
        if (typeof fields === 'string') return refused(fields, null);
        const slug = this.#newSlug(session.seller, fields.description);
        const now = new Date();
        this.#products.set(slug, {
          current: {
            slug,
            seller: session.seller,
            status: 'ONSALE',
            ...fields,
            listedAt: now,
            updatedAt: seconds(now),
            soldAt: null,
          },
          previous: null,
        });
        return redirect(`/products/${slug}/`);
      }
      case 'update':
        return this.#owned(route.slug, session, (stored) => {
          if (stored.current.status !== 'ONSALE') {
            return refused('Only listings on sale can be edited.', stored);
          }
          const fields = listingFields(form, stored.current);
          if (typeof fields === 'string') return refused(fields, stored);
          this.#change(stored, fields);
          return redirect(`/products/${stored.current.slug}/`);
        });
      case 'delete':
        return this.#owned(route.slug, session, (stored) => {
          if (stored.current.status === 'ONSALE') this.#change(stored, { status: 'DELETED' });
          return redirect(`/products/${stored.current.slug}/`);
        });
      case 'read': {
        const stored = this.#products.get(route.slug ?? '');
        if (stored === undefined) return notFound();
        const shown =
          fault?.type === 'stale_read' && stored.previous !== null
            ? stored.previous
            : stored.current;
        return {
          status: 200,
          body: page('Depop', productPage(shown, session), { product: productData(shown) }),
        };
      }
      case 'listings': {
        const { rows, more } = this.#pageOf(
          url,
          this.products()
            .filter((product) => product.seller === session.seller && product.status === 'ONSALE')
            .sort(
              (a, b) => b.listedAt.getTime() - a.listedAt.getTime() || b.slug.localeCompare(a.slug),
            ),
        );
        return {
          status: 200,
          body: page('Selling | Depop', sellingPage(rows), {
            products: rows.map(productData),
            hasMore: more,
          }),
        };
      }
      case 'sold': {
        const { rows, more } = this.#pageOf(
          url,
          this.products()
            .filter((product) => product.seller === session.seller && product.status === 'SOLD')
            .sort((a, b) => (b.soldAt?.getTime() ?? 0) - (a.soldAt?.getTime() ?? 0)),
        );
        return {
          status: 200,
          body: page('Sold items | Depop', soldItemsPage(rows), {
            soldItems: rows.map((product) => ({
              slug: product.slug,
              description: product.description,
              price: priceData(product.priceCents),
              soldAt: (product.soldAt ?? product.updatedAt).toISOString(),
            })),
            hasMore: more,
          }),
        };
      }
    }
  }

  #pageOf(url: URL, rows: FakeDepopProduct[]): { rows: FakeDepopProduct[]; more: boolean } {
    const number = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    return {
      rows: rows.slice((number - 1) * this.#pageSize, number * this.#pageSize),
      more: rows.length > number * this.#pageSize,
    };
  }

  #owned(slug: string | null, session: Session, act: (stored: StoredProduct) => Reply): Reply {
    const stored = slug === null ? undefined : this.#products.get(slug);
    if (stored?.current.seller !== session.seller) return notFound();
    return act(stored);
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
    const slug = [
      seller.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      ...words,
      this.#sequence.toString(36),
    ]
      .join('-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!DEPOP_SLUG.test(slug)) throw new Error(`the fake made an invalid slug ${slug}`);
    return slug;
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
  if (get && path === '/sellinghub/selling/') return { method, action: 'listings', slug: null };
  if (get && path === '/sellinghub/sold-items/') return { method, action: 'sold', slug: null };
  if (path === '/products/create/') {
    if (get) return { method, action: 'form', slug: null };
    if (post) return { method, action: 'create', slug: null };
  }
  const edit = /^\/products\/edit\/([a-z0-9-]+)\/(delete)?$/.exec(path);
  const slug = edit?.[1];
  if (slug !== undefined) {
    if (get && edit?.[2] === undefined) return { method, action: 'form', slug };
    if (post && edit?.[2] === undefined) return { method, action: 'update', slug };
    if (post && edit?.[2] === 'delete') return { method, action: 'delete', slug };
    return null;
  }
  const product = /^\/products\/([a-z0-9-]+)\/$/.exec(path)?.[1];
  if (get && product !== undefined) return { method, action: 'read', slug: product };
  return null;
}

function notFound(): Reply {
  return {
    status: 404,
    body: page(
      'Page not found | Depop',
      '<main data-testid="notFound"><h1>Sorry, we couldn’t find that page.</h1></main>',
      {},
    ),
  };
}

/** The form again, with Depop's message; nothing applied. */
function refused(message: string, stored: StoredProduct | undefined | null): Reply {
  return {
    status: 422,
    body: page(
      'Sell | Depop',
      `<p data-testid="listingForm__error" role="alert">${escape(message)}</p>${listingForm(stored?.current ?? null, null)}`,
      {},
    ),
  };
}

// Forms ---------------------------------------------------------------------------------------

type ListingFields = Pick<
  FakeDepopProduct,
  'description' | 'priceCents' | 'category' | 'size' | 'brand' | 'condition' | 'shipping' | 'photos'
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
  const category = [text('category0'), text('category1'), text('category2')].filter(
    (name) => name !== '',
  );
  const leaf = mappedDepopCategories().find(
    (entry) => entry.path.join(' > ') === category.join(' > '),
  );
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
  if (leaf.size !== 'none' && !SIZES[leaf.size].includes(size)) return 'Choose a size.';
  if (brand !== '' && !(FAKE_DEPOP_BRANDS as readonly string[]).includes(brand)) {
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
    size: leaf.size === 'none' ? null : size,
    brand: brand === '' ? null : brand,
    condition,
    shipping,
    photos: keptPhotos,
  };
}

// Pages ---------------------------------------------------------------------------------------

/** A page with Depop's embedded data, `props.pageProps`. */
/**
 * A page as depop.com serves it: responsive (the app's sign-in page shows it at phone size), with
 * its data.
 */
function page(title: string, body: string, pageProps: Record<string, unknown>): string {
  const data = scriptJson({ props: { pageProps }, page: '/', buildId: 'fake' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title></head><body>${body}<script id="__NEXT_DATA__" type="application/json">${data}</script></body></html>`;
}

/** A page without embedded data. */
function plainPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title></head><body>${body}</body></html>`;
}

/**
 * The sign-in page. Its email field is a text field: an `email` input keeps the app's sign-in web
 * view from going idle in the simulator while it has focus, which stretches every UI test step to
 * the framework's two-minute idle timeout (it made PhoneExecutionUITests time out on CI). Listora
 * never reads this form.
 */
function loginForm(): string {
  return `<main><h1>Log in to Depop</h1><form method="post" action="/login/"><input name="username"><input name="password" type="password"><button type="submit">Log in</button></form><form method="post" action="/login/email-link/"><input name="email" placeholder="Email"><button type="submit">Email me a sign-in link</button></form></main>`;
}

function emailLinkSent(): string {
  return `<main><h1>Check your email</h1><p>We emailed you a link to log in.</p></main>`;
}

function expiredLink(): string {
  return `<main><h1>This link has expired</h1><p>Ask for a new link to log in.</p></main>`;
}

function verifyForm(): string {
  return `<main><h1>Check your email</h1><p>Enter the code we sent to your email.</p><input name="code" inputmode="numeric"><button type="submit">Continue</button></main>`;
}

/** A bot-check block page (no frame or script: nothing leaves this machine). */
function botCheckPage(): string {
  return plainPage(
    'depop.com',
    '<main><h1>Please verify you are a human</h1><p>Access to this page has been denied because we believe you are using automation tools.</p></main>',
  );
}

function captchaWidget(): string {
  return `<div class="h-captcha" data-sitekey="fake-site-key" style="width:304px;height:78px;border:1px solid #ccc">I am human</div>`;
}

function priceData(cents: number): { priceAmount: string; currencyName: string } {
  return {
    priceAmount: `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`,
    currencyName: 'USD',
  };
}

function productData(product: FakeDepopProduct): Record<string, unknown> {
  return {
    slug: product.slug,
    status: product.status,
    description: product.description,
    price: priceData(product.priceCents),
    dateUpdated: product.updatedAt.toISOString(),
    brand: product.brand,
    size: product.size,
    condition: product.condition,
    categories: product.category,
  };
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function productPage(product: FakeDepopProduct, session: Session): string {
  const own = product.seller === session.seller;
  const badge =
    product.status === 'SOLD'
      ? '<span data-testid="product__sold">Sold</span>'
      : product.status === 'DELETED'
        ? '<p data-testid="product__deleted">This item is no longer available.</p>'
        : '';
  const edit =
    own && product.status === 'ONSALE'
      ? `<a data-testid="product__edit" href="/products/edit/${product.slug}/">Edit listing</a>`
      : '';
  return `<main data-testid="productPage">
${badge}
<p data-testid="product__price">${dollars(product.priceCents)}</p>
<p data-testid="product__description" style="white-space:pre-wrap">${escape(product.description)}</p>
<dl><dt>Size</dt><dd>${escape(product.size ?? '')}</dd><dt>Brand</dt><dd>${escape(product.brand ?? '')}</dd>
<dt>Condition</dt><dd>${escape(DEPOP_CONDITION_LABELS[product.condition as keyof typeof DEPOP_CONDITION_LABELS])}</dd></dl>
<p data-testid="sellerUsername">${escape(product.seller)}</p>
${edit}
</main>`;
}

function sellingPage(rows: readonly FakeDepopProduct[]): string {
  const items = rows
    .map(
      (product) =>
        `<li><a href="/products/${product.slug}/">${escape(product.description.slice(0, 40))}</a> ${dollars(product.priceCents)}</li>`,
    )
    .join('');
  return `<main><h1>Selling</h1><ul data-testid="sellingList">${items}</ul></main>`;
}

function soldItemsPage(rows: readonly FakeDepopProduct[]): string {
  const items = rows
    .map(
      (product) =>
        `<li><a href="/products/${product.slug}/">${escape(product.description.slice(0, 40))}</a> ${dollars(product.priceCents)} <span data-testid="buyerName">a buyer</span> <span data-testid="shippingAddress">1 Buyer Street</span></li>`,
    )
    .join('');
  return `<main><h1>Sold items</h1><ul data-testid="soldList">${items}</ul></main>`;
}

/**
 * The listing form, with the small script that makes Depop's pickers work: each category
 * level's options appear once the level above is picked, the size list follows the product
 * type, the brand search suggests brands from Depop's list as the seller types, and Delete asks
 * the browser to confirm.
 */
function listingForm(product: FakeDepopProduct | null, defaultShipping: string | null): string {
  const action = product === null ? '/products/create/' : `/products/edit/${product.slug}/`;
  const value = (text: string | null | undefined): string => escape(text ?? '');
  const tree = mappedDepopCategories().map((entry) => ({ path: entry.path, size: entry.size }));
  const conditions = Object.entries(DEPOP_CONDITION_LABELS)
    .map(
      ([option, label]) =>
        `<label><input type="radio" name="condition" value="${option}"${product?.condition === option ? ' checked' : ''}> ${label}</label>`,
    )
    .join('');
  const shipping = product?.shipping ?? defaultShipping;
  const shippingOptions = Object.entries(FAKE_DEPOP_SHIPPING)
    .map(
      ([option, label]) =>
        `<option value="${option}"${shipping === option ? ' selected' : ''}>${label}</option>`,
    )
    .join('');
  const buttons =
    product === null
      ? '<button type="submit" data-testid="listingForm__post">Post</button>'
      : '<button type="submit" data-testid="listingForm__save">Save changes</button>';
  const remove =
    product === null
      ? ''
      : `<button type="button" data-testid="listingForm__delete">Delete listing</button><form method="post" action="/products/edit/${product.slug}/delete" id="delete-form"></form>`;
  const current = { category: product?.category ?? [], size: product?.size ?? null };
  return `<form method="post" action="${action}" enctype="multipart/form-data" data-testid="listingForm">
<label>Photos <input type="file" name="photos" data-testid="listingForm__photos" multiple accept="image/jpeg"></label>
<label>Description <textarea name="description" data-testid="listingForm__description">${value(product?.description)}</textarea></label>
<select name="category0" data-testid="listingForm__category0"><option value="">Department</option></select>
<select name="category1" data-testid="listingForm__category1"><option value="">Category</option></select>
<select name="category2" data-testid="listingForm__category2"><option value="">Type</option></select>
<select name="size" data-testid="listingForm__size"><option value="">Size</option></select>
<label>Brand <input name="brand" data-testid="listingForm__brand" autocomplete="off" value="${value(product?.brand)}"></label>
<ul data-testid="listingForm__brandSuggestions" hidden></ul>
<fieldset>${conditions}</fieldset>
<label>Price $<input name="price" data-testid="listingForm__price" inputmode="decimal" value="${product === null ? '' : priceData(product.priceCents).priceAmount}"></label>
<select name="shipping" data-testid="listingForm__shipping"><option value="">Shipping</option>${shippingOptions}</select>
${buttons}
</form>
${remove}
<script>
(() => {
  const tree = ${scriptJson(tree)};
  const sizes = ${scriptJson(SIZES)};
  const brands = ${scriptJson(FAKE_DEPOP_BRANDS)};
  const current = ${scriptJson(current)};
  const levels = [0, 1, 2].map((level) => document.querySelector('[data-testid="listingForm__category' + level + '"]'));
  const placeholders = ['Department', 'Category', 'Type'];
  const size = document.querySelector('[data-testid="listingForm__size"]');
  const fill = (select, names, placeholder) => {
    select.replaceChildren(new Option(placeholder, ''), ...names.map((name) => new Option(name, name)));
  };
  const picked = (upTo) => levels.slice(0, upTo).map((select) => select.value);
  const children = (path) => [...new Set(tree
    .filter((entry) => path.every((name, index) => entry.path[index] === name))
    .map((entry) => entry.path[path.length]))];
  const leaf = () => tree.find((entry) => entry.path.join('>') === picked(3).join('>'));
  const refresh = (from) => {
    for (let level = from + 1; level < 3; level += 1) {
      fill(levels[level], picked(level).every(Boolean) ? children(picked(level)) : [], placeholders[level]);
    }
    const entry = leaf();
    fill(size, entry && entry.size !== 'none' ? sizes[entry.size] : [], 'Size');
  };
  fill(levels[0], children([]), placeholders[0]);
  levels.forEach((select, level) => select.addEventListener('change', () => refresh(level)));
  current.category.forEach((name, level) => { levels[level].value = name; refresh(level); });
  if (current.size) size.value = current.size;
  const brand = document.querySelector('[data-testid="listingForm__brand"]');
  const list = document.querySelector('[data-testid="listingForm__brandSuggestions"]');
  brand.addEventListener('input', () => {
    const typed = brand.value.trim().toLowerCase();
    const found = typed === '' ? [] : brands.filter((name) => name.toLowerCase().includes(typed));
    list.replaceChildren(...(found.length === 0
      ? [Object.assign(document.createElement('li'), { textContent: 'No brands found' })]
      : found.map((name) => {
          const option = Object.assign(document.createElement('li'), { textContent: name });
          option.dataset.testid = 'listingForm__brandSuggestion';
          option.addEventListener('click', () => { brand.value = name; list.hidden = true; });
          return option;
        })));
    list.hidden = typed === '';
  });
  const remove = document.querySelector('[data-testid="listingForm__delete"]');
  if (remove) {
    remove.addEventListener('click', () => {
      if (confirm('Delete this listing? This can’t be undone.')) document.getElementById('delete-form').submit();
    });
  }
})();
</script>`;
}

/** JSON for an inline script: `<` escaped, so no value can close the script element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function seconds(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

function copy(product: FakeDepopProduct): FakeDepopProduct {
  return {
    ...product,
    category: [...product.category],
    photos: [...product.photos],
    listedAt: new Date(product.listedAt),
    updatedAt: new Date(product.updatedAt),
    soldAt: product.soldAt === null ? null : new Date(product.soldAt),
  };
}
