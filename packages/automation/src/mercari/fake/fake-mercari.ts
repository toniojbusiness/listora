/**
 * The fake Mercari site: a local web app with the pages and flows of Mercari's US site that
 * the Mercari automation adapter uses (docs/features/mercari.md), for its development and tests.
 * No test sends traffic to Mercari. It mirrors Mercari's pages as the adapter's page modules
 * read them (`pages/`, mapped on a real signed-in session, 2026-10-26 and 27): the same paths,
 * test ids, and page data.
 *
 * The sell page is drawn by its own script once the document is ready, with no form element. A
 * tip about listing templates covers it on a seller's first visit. The category is a dialog of
 * rows, a level at a time, over Mercari's whole catalog (catalog/catalog.json); brand and size
 * are lists of options, the sizes the category's size group lists; the condition is a radio per
 * Mercari condition id. A brand is required: one Mercari doesn't list is its "No brand / Not
 * sure". Descriptions need five words. Shipping starts on "Ship on your own"; Mercari's prepaid
 * label comes with the label Mercari recommends and asks "Offer buyers free shipping?".
 * Smart Pricing starts on, and List refuses it without a lowest price. The edit page draws the
 * same form with Update, and Deactivate or Activate, which act at once and open the seller's
 * active listings. After List or Update, Mercari shows its own page linking to the listing. A
 * listing's page carries the listing in its Next.js page data, sale time included. The seller's
 * tabs are tables whose rows draw a moment after the page loads. Mercari's checks (Cloudflare's
 * interstitial and Turnstile widget, a CAPTCHA, a login code, a logged-out session) and its
 * refusals (an account to verify first, a card to add first, its warning that a listing may be
 * a prohibited item) each come with fault injection. A category can be made to ask for a phone's
 * IMEI (`imeiCategories`), as Mercari's form does for some phones.
 *
 *   GET  /login/                      the login page (a password field: no session needs it)
 *   POST /login/                      log in by hand: any email and password; sets the session cookie
 *   GET  /login/verify/               a login code step
 *   GET  /mypage/                     the seller's account, drawn by its script ([data-testid="EditProfileButton"])
 *   GET  /sell/                       the sell page; POST /sell/ lists (multipart, photos)
 *   GET  /sell/complete/              Mercari's page once a listing is up, after List or Update
 *   GET  /us/item/:id/                a listing's page (its data in `script#__NEXT_DATA__`)
 *   GET  /sell/edit/:id/              the edit form; POST saves it (Update)
 *   POST /sell/edit/:id/deactivate    deactivate (the edit page's Deactivate)
 *   POST /sell/edit/:id/activate      activate an inactive listing (its Activate)
 *   GET  /mypage/listings/:tab/       active, inactive, in_progress, and the done sales at the
 *                                     account page's Sales link; `?page=N`, 10 a page
 *   GET  /photos/<name>.jpg           a photo, standing in for Listora's image CDN (no session)
 *
 * Every page except the login pages and photos needs the session cookie; without a valid one it
 * redirects to the login page. A listing's last change grows by at least a second with every
 * change (automated changes are seconds apart), so it serves as a revision; a stale read serves
 * the listing as it was before its latest change. As Mercari's do, a deleted listing's page
 * answers 410 without the listing, and a sold one whose sale is done answers 410 with its data;
 * an unknown id gets a plain "not found" page.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SessionCookie } from '@listora/connections';

import { FAKE_MEDIA_PATH, fakeMediaName, fakeMediaPhoto } from '../../fake-photos/fake-photos.ts';
import { mercariCatalog } from '../catalog/catalog.ts';
import { MERCARI_CONDITIONS } from '../conditions.ts';
import type { MercariListingTab } from '../site.ts';

export type FakeMercariAction =
  | 'create'
  | 'update'
  | 'end'
  | 'relist'
  | 'read'
  | 'listings'
  | 'health'
  | 'form'
  /** Mercari's page once a new listing is up. */
  | 'listed';

export type FakeMercariFault =
  /** Cloudflare's "Just a moment..." interstitial instead of the page, status 403. */
  | { type: 'cloudflare_interstitial' }
  /** The page, with Cloudflare's Turnstile widget asking to verify a human (status 200). */
  | { type: 'turnstile' }
  /** A visible CAPTCHA widget instead of the page. */
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
  /**
   * On List or Update (`create`, `update`): Mercari's warning that the listing may break its
   * rules ("Oops!", this reason, "Continue listing", "Learn more"), over the form; nothing is
   * applied unless the seller continues.
   */
  | { type: 'item_warning'; message: string }
  /**
   * On the sell page (`form`): Mercari's dialog asking the seller to verify their account
   * before they can list, instead of the form.
   */
  | { type: 'verification_required' }
  /**
   * On List (`create`): Mercari's add-a-card warning, its answer to a seller without a credit or
   * debit card on file; nothing is listed.
   */
  | { type: 'card_required' }
  /**
   * On List or Update: Mercari's own failure under the List button ("Your item could not be
   * listed due to an error"); nothing is changed.
   */
  | { type: 'listing_error' }
  /** The answer comes after `delayMs`; with `afterApply`, the change is made at once. */
  | { type: 'slow'; delayMs: number; afterApply: boolean }
  /** A read serves the listing as it was before its latest change. */
  | { type: 'stale_read' }
  /** The page without the elements the adapter reads, as after a site redesign. */
  | { type: 'redesigned' }
  /** On a listings tab (`listings`): its placeholder rows stay, as when Mercari's query never answers. */
  | { type: 'rows_never_drawn' };

export interface FakeMercariFaultRule {
  action: FakeMercariAction;
  fault: FakeMercariFault;
  /** How many matching requests get it (default 1). */
  times?: number;
}

/**
 * Mercari's states: on sale, deactivated (its page data names it `stop`), sold and waiting to
 * ship, sold and done.
 */
export type FakeMercariStatus = 'on_sale' | 'inactive' | 'trading' | 'sold_out';

export interface FakeMercariItem {
  id: string;
  /** The seller whose session listed it; tabs show only their own. */
  seller: string;
  status: FakeMercariStatus;
  title: string;
  description: string;
  priceCents: number;
  category: string[];
  brand: string | null;
  conditionId: number;
  size: string | null;
  /** The part of the size list the size was picked in (`Standard`, `Petite`). */
  sizeSet: string | null;
  /** Who pays the prepaid label: `Buyer` (no free shipping) or `Seller` (free shipping). */
  shippingPayer: string;
  /** The prepaid label, the one Mercari recommends for the category (`Up to 3 lb`). */
  shippingWeight: string;
  /** Uploaded photo file names, in the order the form sent them. */
  photos: string[];
  listedAt: Date;
  updatedAt: Date;
  soldAt: Date | null;
}

export interface FakeMercariRequest {
  method: string;
  path: string;
  action: FakeMercariAction | null;
  at: number;
  fault: FakeMercariFault['type'] | null;
  status: number;
}

export interface FakeMercariOptions {
  /** Rows per page of the listing tabs (default 10). */
  pageSize?: number;
  /**
   * Whether Mercari's page after List or Update links to the listing (`LiveListingLink`, default
   * true, as Mercari's does). Without the link, the scripts find a new listing by its SKU.
   */
  listedPageLinksItem?: boolean;
  /** Categories (Mercari's names joined with ` > `) whose form asks for a phone's IMEI. */
  imeiCategories?: readonly string[];
  /** Categories the dialog no longer offers, as when Mercari drops one after a catalog read. */
  withoutCategories?: readonly string[];
  /**
   * How the seller's listing tabs are drawn (default `desktop`): Mercari's desktop table, or the
   * mobile layout it shows a touch screen such as the iPhone app's web view (read 2026-10-28).
   */
  layout?: FakeMercariLayout;
}

export type FakeMercariLayout = 'desktop' | 'mobile';

/** Mercari's own brand for an item without one, or one its list doesn't have. */
export const FAKE_MERCARI_NO_BRAND = 'No brand / Not sure';

/** The brands Mercari's brand search offers (a sample of its list). */
export const FAKE_MERCARI_BRANDS = [
  "Levi's",
  'Nike',
  'adidas',
  'Patagonia',
  'Madewell',
  'J.Crew',
  'lululemon athletica',
  'Coach',
  'Zara',
  'Gap',
  'Free People',
  'The North Face',
  'Carhartt',
  'Dr. Martens',
  'Converse',
  'Abercrombie & Fitch',
  FAKE_MERCARI_NO_BRAND,
] as const;

/** The prepaid label class Mercari's form recommends (the fake recommends one for every item). */
export const FAKE_MERCARI_LABEL = 'Up to 1 lb';

interface StoredItem {
  current: FakeMercariItem;
  previous: FakeMercariItem | null;
}

interface Session {
  seller: string;
}

const SESSION_COOKIE = 'fake_mercari_session';
const PHOTO_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const LIMITS = { title: 80, description: 1_000, photos: 12, minDollars: 1, maxDollars: 2_000 };
/**
 * The done sales' tab, where the account page's Sales link goes. Mercari's own path for it is
 * not confirmed, only that it is not `/mypage/listings/sold/`, so the fake serves it elsewhere
 * and the scripts must follow the link.
 */
const SALES_TAB_PATH = '/mypage/listings/complete/';
/** How long after its document is ready a page's own script draws it (Mercari's are client-drawn). */
const DRAW_MS = 300;

export class FakeMercariSite {
  readonly #server: Server;
  readonly #pageSize: number;
  readonly #listedPageLinksItem: boolean;
  readonly #layout: FakeMercariLayout;
  readonly #formOptions: Pick<SellFormOptions, 'imeiCategories' | 'withoutCategories'>;
  readonly #items = new Map<string, StoredItem>();
  readonly #deleted = new Set<string>();
  readonly #sessions = new Map<string, Session>();
  /** Sellers who have seen the sell page's tip about listing templates. */
  readonly #tipped = new Set<string>();
  /** The listing each seller's last List or Update put up, which the page after it shows. */
  readonly #listed = new Map<string, string>();
  readonly #faults: (FakeMercariFaultRule & { remaining: number })[] = [];
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly requests: FakeMercariRequest[] = [];
  #nextId = 10_000_000_001;
  #url = '';

  private constructor(options: FakeMercariOptions) {
    this.#pageSize = options.pageSize ?? 10;
    this.#listedPageLinksItem = options.listedPageLinksItem ?? true;
    this.#layout = options.layout ?? 'desktop';
    this.#formOptions = {
      imeiCategories: options.imeiCategories ?? [],
      withoutCategories: options.withoutCategories ?? [],
    };
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end(error instanceof Error ? error.message : 'error');
        }
      });
    });
  }

  static async start(port = 0, options: FakeMercariOptions = {}): Promise<FakeMercariSite> {
    const site = new FakeMercariSite(options);
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

  inject(rule: FakeMercariFaultRule): void {
    this.#faults.push({ ...rule, remaining: rule.times ?? 1 });
  }

  clearFaults(): void {
    this.#faults.length = 0;
  }

  items(): FakeMercariItem[] {
    return [...this.#items.values()].map((stored) => copy(stored.current));
  }

  item(id: string): FakeMercariItem | undefined {
    const stored = this.#items.get(id);
    return stored === undefined ? undefined : copy(stored.current);
  }

  /** The listings whose description ends with Listora's line for this SKU. */
  itemsWithSku(sku: string): FakeMercariItem[] {
    return this.items().filter((item) => item.description.endsWith(`\n\nSKU: ${sku}`));
  }

  /** Lists an item directly, as the seller once did by hand; returns its id. */
  seed(
    item: Partial<Omit<FakeMercariItem, 'id' | 'updatedAt'>> & {
      title: string;
      priceCents: number;
    },
  ): string {
    const id = this.#newId();
    const now = new Date();
    this.#items.set(id, {
      current: {
        seller: 'fake-seller',
        status: 'on_sale',
        description: 'Listed by hand.',
        category: ['Women', 'Tops & blouses', 'T-shirts'],
        brand: null,
        conditionId: 3,
        size: 'M (8-10)',
        sizeSet: 'Standard',
        shippingPayer: 'Buyer',
        shippingWeight: FAKE_MERCARI_LABEL,
        photos: ['photo.jpg'],
        listedAt: now,
        soldAt: null,
        ...item,
        id,
        updatedAt: seconds(now),
      },
      previous: null,
    });
    return id;
  }

  /** A buyer buys the listing: it is sold and waits to ship (the in-progress tab). */
  sell(id: string, soldAt = new Date()): void {
    const stored = this.#stored(id);
    this.#change(stored, { status: 'trading', soldAt });
  }

  /** The sale completes (the sold tab). */
  complete(id: string): void {
    this.#change(this.#stored(id), { status: 'sold_out' });
  }

  /** The seller deletes the listing; its page then answers 410, as Mercari's does. */
  remove(id: string): void {
    this.#items.delete(id);
    this.#deleted.add(id);
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
    const record: FakeMercariRequest = {
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
        // email with a password starts a session as that seller.
        const form = await readForm(request);
        const seller = form.text('email');
        if (seller !== '' && form.text('password') !== '') {
          const { value } = this.issueSession(seller);
          send({
            status: 303,
            headers: {
              location: '/mypage/',
              'set-cookie': `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
            },
          });
          return;
        }
      }
      send({ status: 200, body: page('Log in | Mercari', loginForm()) });
      return;
    }
    if (url.pathname === '/login/verify/') {
      send({ status: 200, body: page('Verify your phone | Mercari', verifyForm()) });
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

    const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
    const session = token === undefined ? undefined : this.#sessions.get(token);
    const route = matchRoute(method, url.pathname);
    record.action = route?.action ?? null;
    if (session === undefined || token === undefined) {
      send(redirect('/login/'));
      return;
    }
    if (route === null) {
      send({ status: 404, body: page('Page not found | Mercari', notFound()) });
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
    fault: FakeMercariFault | undefined,
  ): Promise<Reply> {
    switch (fault?.type) {
      case 'cloudflare_interstitial':
        return { status: 403, body: cloudflareInterstitial() };
      case 'captcha':
        return { status: 200, body: page('Security check | Mercari', captchaWidget()) };
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
          body: page('Too many requests | Mercari', '<p>Please slow down.</p>'),
        };
      case 'redesigned':
        return { status: 200, body: page('Mercari', '<main><h1>Something new</h1></main>') };
      case 'turnstile':
      case 'server_error':
      case 'reject':
      case 'item_warning':
      case 'verification_required':
      case 'card_required':
      case 'listing_error':
      case 'slow':
      case 'stale_read':
      case 'rows_never_drawn':
      case undefined:
        break;
    }

    const form = route.method === 'POST' ? await readForm(request) : null;
    if (fault?.type === 'reject' && form !== null) {
      return refused(fault.message, route.id === null ? null : this.#items.get(route.id));
    }
    if (fault?.type === 'verification_required' && route.action === 'form' && route.id === null) {
      return { status: 200, body: page('Sell | Mercari', verificationRequired()) };
    }
    if (
      fault?.type === 'item_warning' &&
      (route.action === 'create' || route.action === 'update')
    ) {
      const stored = route.id === null ? undefined : this.#items.get(route.id);
      return {
        status: 200,
        body: page(
          'Sell | Mercari',
          listingForm(stored?.current ?? null, {
            itemWarning: fault.message,
            ...this.#formOptions,
          }),
        ),
      };
    }
    if (
      fault?.type === 'listing_error' &&
      (route.action === 'create' || route.action === 'update')
    ) {
      // The form again, with Mercari's error under its List button.
      const stored = route.id === null ? null : this.#items.get(route.id);
      return {
        status: 200,
        body: page(
          'Sell | Mercari',
          listingForm(stored?.current ?? null, { listingError: true, ...this.#formOptions }),
        ),
      };
    }
    if (fault?.type === 'card_required' && route.action === 'create') {
      // The form again, with the warning over it.
      return {
        status: 200,
        body: page(
          'Sell | Mercari',
          listingForm(null, { paymentWarning: true, ...this.#formOptions }),
        ),
      };
    }
    const apply = (): Reply => this.#apply(route, url, form, session, fault);
    if (fault?.type === 'server_error') {
      if (fault.afterApply === true) apply();
      return { status: 500, body: page('Something went wrong | Mercari', '<p>Error.</p>') };
    }
    if (fault?.type === 'slow') {
      const early = fault.afterApply ? apply() : undefined;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.#timers.delete(timer);
          resolve();
        }, fault.delayMs);
        this.#timers.add(timer);
      });
      return early ?? apply();
    }
    const reply = apply();
    if (fault?.type === 'turnstile' && reply.body !== undefined) {
      // Cloudflare's managed challenge, shown over the page Mercari served.
      return { ...reply, body: reply.body.replace('<body>', `<body>${turnstileWidget()}`) };
    }
    return reply;
  }

  #apply(
    route: Route,
    url: URL,
    form: SubmittedForm | null,
    session: Session,
    fault: FakeMercariFault | undefined,
  ): Reply {
    switch (route.action) {
      case 'health':
        return {
          status: 200,
          body: page('My page | Mercari', accountPage()),
        };
      case 'form':
        if (route.id === null) {
          // The tip about listing templates shows on a seller's first visit.
          const templatesTip = !this.#tipped.has(session.seller);
          this.#tipped.add(session.seller);
          return {
            status: 200,
            body: page('Sell | Mercari', listingForm(null, { templatesTip, ...this.#formOptions })),
          };
        }
        return this.#owned(route.id, session, (stored) =>
          stored.current.status === 'on_sale' || stored.current.status === 'inactive'
            ? {
                status: 200,
                body: page(
                  'Edit listing | Mercari',
                  listingForm(stored.current, { ...this.#formOptions }),
                ),
              }
            : redirect(`/us/item/${stored.current.id}/`),
        );
      case 'create': {
        const fields = listingFields(form, null, this.#formOptions);
        if (typeof fields === 'string') return refused(fields, undefined);
        const id = this.#newId();
        const now = new Date();
        this.#items.set(id, {
          current: {
            id,
            seller: session.seller,
            status: 'on_sale',
            ...fields,
            listedAt: now,
            updatedAt: seconds(now),
            soldAt: null,
          },
          previous: null,
        });
        this.#listed.set(session.seller, id);
        return redirect('/sell/complete/');
      }
      case 'listed':
        return this.#owned(this.#listed.get(session.seller) ?? null, session, (stored) => ({
          status: 200,
          body: page('Listed | Mercari', listedPage(stored.current, this.#listedPageLinksItem)),
        }));
      case 'update':
        return this.#owned(route.id, session, (stored) => {
          if (stored.current.status !== 'on_sale' && stored.current.status !== 'inactive') {
            return refused('Sold items cannot be edited.', stored);
          }
          const fields = listingFields(form, stored.current, this.#formOptions);
          if (typeof fields === 'string') return refused(fields, stored);
          this.#change(stored, fields);
          // The same page as after List (read 2026-10-27).
          this.#listed.set(session.seller, stored.current.id);
          return redirect('/sell/complete/');
        });
      // Mercari opens the seller's active listings after Deactivate (read 2026-10-27), and the
      // fake does the same after Activate.
      case 'end':
        return this.#owned(route.id, session, (stored) => {
          if (stored.current.status === 'on_sale') this.#change(stored, { status: 'inactive' });
          return redirect('/mypage/listings/active/');
        });
      case 'relist':
        return this.#owned(route.id, session, (stored) => {
          if (stored.current.status === 'inactive') this.#change(stored, { status: 'on_sale' });
          return redirect('/mypage/listings/active/');
        });
      case 'read': {
        const id = route.id ?? '';
        if (this.#deleted.has(id)) {
          // As Mercari answers for a deleted item (seen 2026-10-27).
          return {
            status: 410,
            body: page('Mercari', '<main><h1>This item is no longer available</h1></main>'),
          };
        }
        const stored = this.#items.get(id);
        if (stored === undefined)
          return { status: 404, body: page('Page not found | Mercari', notFound()) };
        const shown =
          fault?.type === 'stale_read' && stored.previous !== null
            ? stored.previous
            : stored.current;
        // A sold item's page answers 410 too, with its data (read 2026-10-27).
        return {
          status: shown.status === 'sold_out' ? 410 : 200,
          body: page(`${shown.title} | Mercari`, itemPage(shown, session, this.url)),
        };
      }
      case 'listings': {
        const tab = route.tab ?? 'active';
        const number = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
        const status = TAB_STATUS[tab];
        // The sold tabs by their rows' last change (a sale changes its row), newest first.
        const sold = tab === 'in_progress' || tab === 'sold';
        const rows = this.items()
          .filter((item) => item.seller === session.seller && item.status === status)
          .sort(
            (a, b) =>
              (sold
                ? b.updatedAt.getTime() - a.updatedAt.getTime()
                : b.listedAt.getTime() - a.listedAt.getTime()) || b.id.localeCompare(a.id),
          );
        const pageRows = rows.slice((number - 1) * this.#pageSize, number * this.#pageSize);
        const more = rows.length > number * this.#pageSize;
        return {
          status: 200,
          body: page(
            'Listings | Mercari',
            listingsPage(tab, pageRows, number, more, {
              layout: this.#layout,
              drawn: fault?.type !== 'rows_never_drawn',
            }),
          ),
        };
      }
    }
  }

  #owned(id: string | null, session: Session, act: (stored: StoredItem) => Reply): Reply {
    const stored = id === null ? undefined : this.#items.get(id);
    if (stored?.current.seller !== session.seller) {
      return { status: 404, body: page('Page not found | Mercari', notFound()) };
    }
    return act(stored);
  }

  #stored(id: string): StoredItem {
    const stored = this.#items.get(id);
    if (stored === undefined) throw new Error(`no item ${id}`);
    return stored;
  }

  #change(stored: StoredItem, change: Partial<FakeMercariItem>): void {
    stored.previous = copy(stored.current);
    // Mercari's last-updated time; automated changes are seconds apart, so it always grows.
    const updatedAt = new Date(
      Math.max(seconds(new Date()).getTime(), stored.current.updatedAt.getTime() + 1_000),
    );
    stored.current = { ...stored.current, ...change, updatedAt };
  }

  #newId(): string {
    const id = `m${String(this.#nextId)}`;
    this.#nextId += 1;
    return id;
  }

  #takeFault(action: FakeMercariAction): FakeMercariFault | undefined {
    const rule = this.#faults.find(
      (candidate) => candidate.action === action && candidate.remaining > 0,
    );
    if (rule === undefined) return undefined;
    rule.remaining -= 1;
    return rule.fault;
  }
}

// Routing -------------------------------------------------------------------------------------

const TAB_STATUS: Readonly<Record<MercariListingTab, FakeMercariStatus>> = {
  active: 'on_sale',
  inactive: 'inactive',
  in_progress: 'trading',
  sold: 'sold_out',
};

interface Route {
  method: 'GET' | 'POST';
  action: FakeMercariAction;
  id: string | null;
  tab?: MercariListingTab;
}

function matchRoute(method: string, path: string): Route | null {
  if (method === 'GET' && path === '/mypage/') return { method, action: 'health', id: null };
  if (method === 'GET' && path === '/sell/') return { method, action: 'form', id: null };
  if (method === 'POST' && path === '/sell/') return { method, action: 'create', id: null };
  if (method === 'GET' && path === '/sell/complete/') return { method, action: 'listed', id: null };
  if (method === 'GET' && path === SALES_TAB_PATH) {
    return { method, action: 'listings', id: null, tab: 'sold' };
  }
  const tab = /^\/mypage\/listings\/(active|inactive|in_progress)\/$/.exec(path)?.[1];
  if (method === 'GET' && tab !== undefined) {
    return { method, action: 'listings', id: null, tab: tab as MercariListingTab };
  }
  const item = /^\/us\/item\/([A-Za-z0-9-]+)\/$/.exec(path)?.[1];
  if (method === 'GET' && item !== undefined) return { method, action: 'read', id: item };
  const edit = /^\/sell\/edit\/([A-Za-z0-9-]+)\/(deactivate|activate)?$/.exec(path);
  const id = edit?.[1];
  if (id === undefined) return null;
  const sub = edit?.[2];
  if (method === 'GET' && sub === undefined) return { method, action: 'form', id };
  if (method === 'POST' && sub === undefined) return { method, action: 'update', id };
  if (method === 'POST' && sub === 'deactivate') return { method, action: 'end', id };
  if (method === 'POST' && sub === 'activate') return { method, action: 'relist', id };
  return null;
}

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

function redirect(location: string): Reply {
  return { status: 303, headers: { location } };
}

/** The form again, with Mercari's message; nothing applied. */
function refused(message: string, stored: StoredItem | undefined | null): Reply {
  return {
    status: 422,
    body: page(
      'Sell | Mercari',
      `<p data-testid="FormError" role="alert">${escape(message)}</p>${listingForm(stored?.current ?? null)}`,
    ),
  };
}

// Forms ---------------------------------------------------------------------------------------

interface SubmittedForm {
  text(name: string): string;
  /** The names of the non-empty files sent in `name`, in order. */
  files(name: string): string[];
}

async function readForm(request: IncomingMessage): Promise<SubmittedForm> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
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

type ListingFields = Pick<
  FakeMercariItem,
  | 'title'
  | 'description'
  | 'priceCents'
  | 'category'
  | 'brand'
  | 'conditionId'
  | 'size'
  | 'sizeSet'
  | 'shippingPayer'
  | 'shippingWeight'
  | 'photos'
>;

/**
 * The sell page's fields, as its script sends them, or Mercari's message for the first problem.
 */
function listingFields(
  form: SubmittedForm | null,
  existing: FakeMercariItem | null,
  options: Pick<SellFormOptions, 'imeiCategories' | 'withoutCategories'>,
): ListingFields | string {
  const text = (name: string): string => form?.text(name) ?? '';
  const title = text('name');
  const description = text('description');
  const price = text('price');
  const photos = form?.files('photos') ?? [];
  const category = text('category')
    .split(' > ')
    .filter((name) => name !== '');
  const chosen = mercariCatalog().find(category);
  const group = chosen?.sizeGroupId ?? null;
  const sizes = group === null ? [] : mercariCatalog().sizeLabels(group);
  const brand = text('brand');
  const condition = Number(text('condition'));
  const size = text('size');
  const sizeSet = text('sizeSet');
  const label = text('shippingLabel');
  const freeShipping = text('freeShipping');
  const keptPhotos = photos.length === 0 && existing !== null ? existing.photos : photos;
  if (keptPhotos.length === 0) return 'Add at least 1 photo.';
  if (keptPhotos.length > LIMITS.photos) return 'You can add up to 12 photos.';
  if (title === '') return 'Enter a title.';
  if (title.length > LIMITS.title) return 'Title must be 80 characters or less.';
  if (description === '') return 'Enter a description.';
  if (description.split(/\s+/).filter((word) => word !== '').length < 5) {
    return 'Your description needs to be at least 5 words.';
  }
  if (description.length > LIMITS.description) {
    return 'Description must be 1,000 characters or less.';
  }
  // A department alone is not a category a listing can be in.
  const named = category.join(' > ');
  if (
    chosen === null ||
    category.length < 2 ||
    options.withoutCategories?.includes(named) === true
  ) {
    return 'Select a category to continue';
  }
  if (options.imeiCategories?.includes(named) === true && text('imei') === '') {
    return 'IMEI can not be empty.';
  }
  if (!(FAKE_MERCARI_BRANDS as readonly string[]).includes(brand)) return 'Please select a brand.';
  if (!Object.values(MERCARI_CONDITIONS).some((option) => option.id === condition)) {
    return 'Select the condition.';
  }
  const sets = group === null ? [] : mercariCatalog().sizeSets(group);
  if (sizes.length > 0 && !sets.some((set) => set.name === sizeSet && set.labels.includes(size))) {
    return 'Size can not be empty.';
  }
  if (text('shipping') !== 'MERCARI') return 'Enter a shipping price, or choose a prepaid label.';
  if (label !== FAKE_MERCARI_LABEL) return 'Select a shipping label.';
  if (freeShipping !== 'yes' && freeShipping !== 'no') {
    return 'Choose whether to offer buyers free shipping.';
  }
  if (!/^\d+$/.test(price)) return 'Enter a price in whole dollars.';
  const dollars = Number(price);
  if (dollars < LIMITS.minDollars || dollars > LIMITS.maxDollars) {
    return 'Price must be between $1 and $2,000.';
  }
  return {
    title,
    description,
    priceCents: dollars * 100,
    category,
    brand: brand === FAKE_MERCARI_NO_BRAND ? null : brand,
    conditionId: condition,
    size: sizes.length === 0 ? null : size,
    sizeSet: sizes.length === 0 ? null : sizeSet,
    shippingPayer: freeShipping === 'yes' ? 'Seller' : 'Buyer',
    shippingWeight: label,
    photos: keptPhotos,
  };
}

// Pages ---------------------------------------------------------------------------------------

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body>${body}</body></html>`;
}

/**
 * The seller's account page as Mercari serves it (read 2026-10-26): a static page whose scripts
 * draw the seller's own account section, with its edit-profile button, after the document is
 * ready.
 */
function accountPage(): string {
  const drawn =
    '<section data-testid="SellerInfo"><h1 data-testid="DisplayName">Your account</h1>' +
    '<a data-testid="EditProfileButton" href="/mypage/profile/">Edit profile</a></section>' +
    '<div data-testid="Balance">$0</div>' +
    '<a data-testid="My-listings" href="/mypage/listings/active/">Listings</a>' +
    `<a data-testid="Sales" href="${SALES_TAB_PATH}">Sales</a>` +
    '<form data-testid="LogoutForm" method="post" action="/logout"><button>Log out</button></form>';
  return `<main id="mypage"></main><script>setTimeout(() => { document.getElementById('mypage').innerHTML = ${JSON.stringify(drawn)}; }, ${String(DRAW_MS)});</script>`;
}

function notFound(): string {
  return '<main data-testid="NotFound"><h1>We couldn’t find that page.</h1></main>';
}

/**
 * The login form. Its email field is a text field: an `email` input keeps the app's sign-in web
 * view from ever going idle in the simulator while it has focus, which slows every UI test step
 * to the framework's two-minute idle timeout. Listora never reads this form (linking keeps only
 * the session cookie), so it changes nothing the adapter relies on.
 */
function loginForm(): string {
  return `<main><h1>Log in to Mercari</h1><form method="post" action="/login/"><input name="email" type="text"><input name="password" type="password"><button type="submit">Log in</button></form></main>`;
}

function verifyForm(): string {
  return `<main><h1>Verify it’s you</h1><p>Enter the code we sent to your phone.</p><input name="code" inputmode="numeric"><button type="submit">Verify</button></main>`;
}

/** Cloudflare's interstitial (no frame or script: nothing leaves this machine). */
function cloudflareInterstitial(): string {
  return `<!doctype html><html lang="en-US"><head><title>Just a moment...</title></head><body><div class="main-wrapper"><h1>www.mercari.com</h1><h2>Verifying you are human. This may take a few seconds.</h2><div id="challenge-stage" style="width:300px;height:65px"></div><form id="challenge-form" action="/" method="post"></form></div></body></html>`;
}

/** Cloudflare's Turnstile widget as a page shows it (without its frame, which is remote). */
function turnstileWidget(): string {
  return `<div class="cf-turnstile" data-sitekey="fake-turnstile-key" style="width:300px;height:65px;border:1px solid #ccc">Verify you are human</div>`;
}

function captchaWidget(): string {
  return `<p>Please complete the security check.</p><div class="g-recaptcha" data-sitekey="fake-site-key" style="width:304px;height:78px;border:1px solid #ccc"></div>`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function itemPage(item: FakeMercariItem, session: Session, origin: string): string {
  const own = item.seller === session.seller;
  const badge =
    item.status === 'trading' || item.status === 'sold_out'
      ? '<span data-testid="ItemSoldBadge">SOLD</span>'
      : '';
  const inactive =
    item.status === 'inactive'
      ? '<p data-testid="ItemInactiveNotice">This listing is inactive. Buyers can’t see it.</p>'
      : '';
  const edit =
    own && (item.status === 'on_sale' || item.status === 'inactive')
      ? `<a data-testid="EditListingButton" href="/sell/edit/${item.id}/">Edit listing</a>`
      : '';
  const condition =
    Object.values(MERCARI_CONDITIONS).find((option) => option.id === item.conditionId)?.label ?? '';
  return `<main data-testid="ItemDetail">
${badge}${inactive}
<h1 data-testid="ItemName">${escape(item.title)}</h1>
<p data-testid="ItemPrice">${dollars(item.priceCents)}</p>
<p data-testid="ItemDescription" style="white-space:pre-wrap">${escape(item.description)}</p>
<dl><dt>Condition</dt><dd data-testid="ItemCondition">${escape(condition)}</dd>
<dt>Brand</dt><dd data-testid="ItemBrand">${escape(item.brand ?? '')}</dd>
<dt>Category</dt><dd data-testid="ItemCategory">${escape(item.category.join(' > '))}</dd>
<dt>Size</dt><dd data-testid="ItemSize">${escape(item.size ?? '')}</dd></dl>
<p>Updated <time data-testid="ItemUpdated" datetime="${item.updatedAt.toISOString()}">${item.updatedAt.toUTCString()}</time></p>
<p data-testid="UserName">fake seller</p>
${edit}
</main>
${itemData(item, origin)}`;
}

/**
 * The listing in the page's Next.js data, as Mercari's item page carries it (read 2026-10-27):
 * `props.pageProps.serverState["ItemDetail:<id>"]`, with the price in cents, Mercari's status
 * name (`stop` for a listing the seller deactivated), the last change, and when it last sold
 * (0 before it ever did), both in seconds.
 */
/** The names Mercari gives its conditions, by id (conditions.ts). */
const MERCARI_CONDITION_NAMES: Readonly<Record<number, string>> = Object.fromEntries(
  Object.values(MERCARI_CONDITIONS).map((condition) => [condition.id, condition.label]),
);

function itemData(item: FakeMercariItem, origin: string): string {
  // The item's condition, size, brand, and categories are references to records of their own,
  // as in Mercari's Apollo cache (read on the captain's listing, 2026-10-27).
  const ref = (key: string) => ({ __ref: key });
  const condition = MERCARI_CONDITION_NAMES[item.conditionId] ?? 'Good';
  const records: Record<string, unknown> = {
    [`ItemDetailItemCondition:${String(item.conditionId)}`]: {
      __typename: 'ItemDetailItemCondition',
      id: String(item.conditionId),
      name: condition,
    },
    ...(item.size === null
      ? {}
      : { 'ItemDetailItemSize:1': { __typename: 'ItemDetailItemSize', id: '1', name: item.size } }),
    ...(item.brand === null
      ? {}
      : {
          'ItemDetailItemBrand:1': { __typename: 'ItemDetailItemBrand', id: '1', name: item.brand },
        }),
    ...Object.fromEntries(
      item.category.map((name, index) => [
        `MasterItemCategory:${String(index + 1)}`,
        { __typename: 'MasterItemCategory', id: String(index + 1), name },
      ]),
    ),
  };
  const data = {
    props: {
      pageProps: {
        serverState: {
          ...records,
          [`ItemDetail:${item.id}`]: {
            id: item.id,
            name: item.title,
            price: item.priceCents,
            description: item.description,
            status: item.status === 'inactive' ? 'stop' : item.status,
            created: Math.floor(item.listedAt.getTime() / 1000),
            updated: Math.floor(item.updatedAt.getTime() / 1000),
            lastSoldAt: item.soldAt === null ? 0 : Math.floor(item.soldAt.getTime() / 1000),
            // What an import reads (pages/listing-details.ts), the photos on the fake's own
            // image CDN (`/media/`, fake-photos.ts).
            photos: item.photos.map((name, index) => {
              const url = `${origin}/media/${fakeMediaName(`${item.id}-${String(index)}-${name}`)}.jpg`;
              return { __typename: 'ItemDetailPhoto', imageUrl: url, thumbnail: url };
            }),
            itemCondition: ref(`ItemDetailItemCondition:${String(item.conditionId)}`),
            itemSize: item.size === null ? null : ref('ItemDetailItemSize:1'),
            brand: item.brand === null ? null : ref('ItemDetailItemBrand:1'),
            itemCategoryHierarchy: item.category.map((_name, index) =>
              ref(`MasterItemCategory:${String(index + 1)}`),
            ),
            categoryTitle: item.category.at(-1) ?? null,
          },
        },
      },
    },
    page: '/us/item/[id]',
    query: { id: item.id },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${scriptJson(data)}</script>`;
}

/**
 * Mercari's page once a listing is up, after List and after an edit's Update alike (read
 * 2026-10-27: under the sell page's path, with "Sell another item" and "Share your listing"),
 * with its link to the listing's page (`LiveListingLink`) unless `links` is false.
 */
function listedPage(item: FakeMercariItem, links: boolean): string {
  const link = links
    ? `<a data-testid="LiveListingLink" href="/us/item/${item.id}/">View your listing</a>`
    : '';
  return `<main data-testid="ListingComplete"><h1>Your item is listed</h1><p>${escape(item.title)}</p>
${link}
<button type="button" data-testid="ShareListing">Share your listing</button>
<a data-testid="SellAnotherItem" href="/sell/">Sell another item</a></main>`;
}

/**
 * Mercari's dialog on the sell page for a seller it wants verified first (read 2026-10-26),
 * drawn instead of the form.
 */
function verificationRequired(): string {
  const drawn =
    '<div data-testid="VerificationExceptionDialog" role="dialog"><h2>Verify your account to start selling</h2>' +
    '<p>Mercari needs your phone number and your ID before you can list.</p>' +
    '<button type="button" data-testid="VerifyButton">Verify</button></div>';
  return `<main id="sell"></main><script>setTimeout(() => { document.getElementById('sell').innerHTML = ${JSON.stringify(drawn)}; }, ${String(DRAW_MS)});</script>`;
}

/** A day as the seller's tabs show it (`11/16/24`), in Mercari's US Pacific time. */
const SHOWN_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  month: '2-digit',
  day: '2-digit',
  year: '2-digit',
});

/**
 * How long Mercari's placeholder rows show while its query for a tab's rows runs (on the phone,
 * about a second, read 2026-10-28).
 */
const PLACEHOLDER_MS = 600;

/**
 * A tab of the seller's listings, as Mercari's are (read 2026-10-26 to 28): drawn by script once
 * the document is ready, and an empty tab shows `ZeroListings` instead of rows. In the desktop
 * layout a tab is a table (`Listings`) whose rows draw a moment after it, once Mercari's own query
 * answers, each with its listing's link (the title as its text), its price, and the day it last
 * changed ("Updated"). The mobile layout is a list of `ListItem`s: while the query runs, three
 * placeholder rows (`ListingRow`s that link to nothing), then the rows, which link to their
 * listing through the photo (`ProductThumbWrapper`) and the title, with no `ItemLink` or
 * `ItemPrice`, or `ZeroListings` in their place. A sold row shows no sale time: that is on the
 * listing's page.
 */
function listingsPage(
  tab: MercariListingTab,
  rows: readonly FakeMercariItem[],
  number: number,
  more: boolean,
  shown: { layout: FakeMercariLayout; drawn: boolean },
): string {
  const path = tab === 'sold' ? SALES_TAB_PATH : `/mypage/listings/${tab}/`;
  const next = more
    ? `<a data-testid="NextPage" href="${path}?page=${String(number + 1)}">Next</a>`
    : '';
  const draw = (into: string, html: string, afterMs: number): string =>
    `setTimeout(() => { document.getElementById(${JSON.stringify(into)}).innerHTML = ${scriptJson(html)}; }, ${String(afterMs)});`;
  const empty = '<div data-testid="ZeroListings">No listings yet</div>';
  const shell = (script: string): string =>
    `<main data-testid="MyListings"><h1>Listings</h1><div id="tab"></div></main><script>${script}</script>`;
  if (shown.layout === 'mobile') {
    const placeholders =
      '<ul id="rows">' +
      '<li data-testid="ListItem"><div data-testid="ListingRow"><div style="height:76px"></div></div></li>'.repeat(
        3,
      ) +
      '</ul><div id="more"></div>';
    const items = rows
      .map(
        (item) =>
          `<li data-testid="ListItem"><div data-testid="ListingRow"><a data-testid="ProductThumbWrapper" href="/us/item/${item.id}/"><img alt="${escape(item.title)}""></a>` +
          `<a data-testid="RowItemWithMeta" href="/us/item/${item.id}/"><p>${escape(item.title)}</p></a>` +
          `<a data-testid="ViewOrderButton" href="/transaction/order_status/${item.id}/">View order</a></div></li>`,
      )
      .join('');
    const drawn = shown.drawn
      ? rows.length === 0
        ? draw('tab', empty, DRAW_MS + PLACEHOLDER_MS)
        : `${draw('rows', items, DRAW_MS + PLACEHOLDER_MS)} ${draw('more', next, DRAW_MS + PLACEHOLDER_MS)}`
      : '';
    return shell(`${draw('tab', placeholders, DRAW_MS)} ${drawn}`);
  }
  if (rows.length === 0) return shell(shown.drawn ? draw('tab', empty, DRAW_MS) : '');
  const items = rows
    .map(
      (item) =>
        `<tr data-testid="ListingRow"><td><a data-testid="ItemLink" href="/us/item/${item.id}/">${escape(item.title)}</a></td><td data-testid="ItemPrice">${dollars(item.priceCents)}</td><td>${SHOWN_DAY.format(item.updatedAt)}</td></tr>`,
    )
    .join('');
  const table =
    '<table data-testid="Listings"><thead><tr><th>Item</th><th>Price</th><th>Updated</th></tr></thead><tbody id="rows"></tbody></table><div id="more"></div>';
  const drawn = shown.drawn ? `${draw('rows', items, 200)} ${draw('more', next, 200)}` : '';
  return shell(
    `setTimeout(() => { document.getElementById('tab').innerHTML = ${scriptJson(table)}; ${drawn} }, ${String(DRAW_MS)});`,
  );
}

interface SellFormOptions {
  /** The tip about listing templates, over a new listing's form on a seller's first visit. */
  templatesTip?: boolean;
  /** Mercari's add-a-card warning over the form, its answer to List without a card on file. */
  paymentWarning?: boolean;
  /** Mercari's own failure under the List button ("Your item could not be listed ..."). */
  listingError?: boolean;
  /** Mercari's warning that the listing may break its rules, with this reason, over the form. */
  itemWarning?: string;
  /** Categories whose form asks for a phone's IMEI. */
  imeiCategories?: readonly string[];
  /** Categories the dialog leaves out. */
  withoutCategories?: readonly string[];
}

/** A dialog over the whole page, as Mercari's tips, confirmations, and warnings are. */
const OVERLAY =
  'position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4)';
const OVERLAY_BOX = 'background:#fff;padding:16px;border-radius:8px';

/**
 * The listing form as Mercari's sell page draws it (read 2026-10-27), on the sell page for a new
 * listing and on a listing's edit page. Its script draws it with no form element, its parts
 * named by test ids:
 *
 * - The category button opens a dialog of rows (`DialogWrapper`, `CategoryRow`), a level at a
 *   time from the top; picking a row that has no rows under it closes the dialog, and the
 *   button then shows the path (`Men > Tops > T-shirts`). A category Listora maps that has
 *   subcategories of its own (`Men > Coats & jackets`) is chosen when its row is picked, and
 *   the dialog stays on its subcategories for a deeper pick.
 * - Brand is a search: focusing it starts a new one, and typing lists Mercari's matching brands
 *   (`Brand-option`) to pick from. The size field (for a category with sizes) lists the
 *   category's sizes (`Size-option`) when tapped.
 * - Condition is a radio per Mercari condition id. Shipping starts on "Ship on your own";
 *   Mercari's prepaid label (`MercariShipping`) shows the label Mercari recommends for the
 *   category (`SelectShipping`) and asks "Offer buyers free shipping?" (`ShippingPayerOption`,
 *   answered Yes or No).
 * - Smart Pricing (`SmartPricingButton`, reading ON or OFF) starts on for a new listing; turning
 *   it off asks to confirm (`SmartPricingTurnOffButton`). List with it on marks the price as
 *   needing a lowest price, and nothing is sent.
 *
 * `ListButton` (List on the sell page, Update on the edit page) sends what the form holds,
 * photos included, as the page's script would. The edit page also has the listing's
 * `ActivateDeactivateButton` (Deactivate or Activate), which acts at once, with no confirmation
 * (read 2026-10-27). Both pages are drawn a moment after their document is ready.
 */
function listingForm(item: FakeMercariItem | null, options: SellFormOptions = {}): string {
  const value = (text: string | null | undefined): string => escape(text ?? '');
  const conditions = Object.values(MERCARI_CONDITIONS)
    .map(
      (option) =>
        `<label><input type="radio" name="condition" value="${String(option.id)}"${item?.conditionId === option.id ? ' checked' : ''}> ${option.label}</label>`,
    )
    .join('');
  const tip =
    options.templatesTip === true
      ? `<div data-testid="ListingTemplatesEducation" role="dialog" aria-modal="true" style="${OVERLAY}"><div style="${OVERLAY_BOX}"><p>New: save a listing as a template and start the next one from it.</p><button type="button" data-testid="ListingTemplatesEducationGotIt">Got it</button></div></div>`
      : '';
  const prepaid = item !== null;
  const smartPricing = item === null;
  const toggle =
    item === null
      ? ''
      : item.status === 'on_sale'
        ? `<button type="button" data-testid="ActivateDeactivateButton" data-action="/sell/edit/${item.id}/deactivate">Deactivate</button>`
        : `<button type="button" data-testid="ActivateDeactivateButton" data-action="/sell/edit/${item.id}/activate">Activate</button>`;
  const html = `${tip}<h1>${item === null ? 'List an item' : 'Edit your listing'}</h1>
<label>Photos <input type="file" data-testid="SellPhotoInput" multiple accept="image/jpeg"></label>
<label>Title <input data-testid="Title" value="${value(item?.title)}"></label>
<label>Description <textarea data-testid="Description">${value(item?.description)}</textarea></label>
<p>Category <button type="button" data-testid="SellCategoryFieldButton">${item === null ? 'Select a category' : escape(item.category.join(' > '))}</button></p>
<div id="categories"></div>
<div id="imei"></div>
<label>Brand <input data-testid="Brand" autocomplete="off" placeholder="Search brands" value="${value(item?.brand)}"></label>
<ul id="brands" role="listbox"></ul>
<fieldset><legend>Condition</legend>${conditions}</fieldset>
<div id="size"></div>
<ul id="sizes" role="listbox"></ul>
<fieldset><legend>Shipping</legend>
<label><input type="radio" id="SHIP_ON_YOUR_OWN" name="shipping" value="SHIP_ON_YOUR_OWN"${prepaid ? '' : ' checked'}> Ship on your own</label>
<input type="radio" id="MERCARI" name="shipping" value="MERCARI"${prepaid ? ' checked' : ''}> <button type="button" data-testid="MercariShipping">Mercari prepaid label</button>
<div id="prepaid"></div>
</fieldset>
<label>Price $<input data-testid="Price" inputmode="numeric" value="${item === null ? '' : String(item.priceCents / 100)}"></label>
<p id="price-error" role="alert"></p>
<p>Smart Pricing <button type="button" data-testid="SmartPricingButton">${smartPricing ? 'ON' : 'OFF'}</button></p>
<div id="smart-pricing"></div>
<button type="button" data-testid="ListButton">${item === null ? 'List' : 'Update'}</button>
${options.listingError === true ? '<p data-testid="ListingError">Your item could not be listed due to an error.<br>Please return to the Home screen and try listing the item again.</p>' : ''}
${toggle}`;
  const config = {
    html,
    action: item === null ? '/sell/' : `/sell/edit/${item.id}/`,
    // Every category of Mercari's catalog, a row per level, and its size group's labels.
    tree: [...mercariCatalog().byId.values()]
      .filter((category) => options.withoutCategories?.includes(category.path.join(' > ')) !== true)
      .map((category) => ({
        path: category.path,
        size: category.sizeGroupId,
        imei: (options.imeiCategories ?? []).includes(category.path.join(' > ')),
        leaf: !category.hasChildren,
      })),
    sizes: Object.fromEntries(
      [...mercariCatalog().sizeGroups.keys()].map((id) => [id, mercariCatalog().sizeSets(id)]),
    ),
    label: FAKE_MERCARI_LABEL,
    brands: FAKE_MERCARI_BRANDS,
    state: {
      category: item?.category ?? [],
      brand: item?.brand ?? null,
      size: item?.size ?? null,
      sizeSet: item?.sizeSet ?? null,
      shipping: prepaid ? 'MERCARI' : 'SHIP_ON_YOUR_OWN',
      freeShipping: item === null ? null : item.shippingPayer === 'Seller' ? 'yes' : 'no',
      smartPricing,
    },
  };
  const itemWarning =
    options.itemWarning === undefined
      ? ''
      : `<div role="dialog" aria-modal="true" style="${OVERLAY}"><div style="${OVERLAY_BOX}"><h2>Oops!</h2><p>${escape(options.itemWarning)}</p><button type="button" data-testid="ItemCreationWarningModalContinueButton">Continue listing</button><a href="/us/help_center/article/318/" data-testid="ItemCreationWarningLearnMoreButton">Learn more</a></div></div>`;
  const warning =
    options.paymentWarning === true
      ? `<div data-testid="PaymentWarningModal" role="dialog" aria-modal="true" style="${OVERLAY}"><div style="${OVERLAY_BOX}"><h2>Add a credit or debit card</h2><p>Mercari needs a payment method on file before you can list.</p><a href="/mypage/payment/">Add credit / debit card</a></div></div>`
      : '';
  return `<main id="sell"></main>${warning}${itemWarning}
<script>
(() => {
  const config = ${scriptJson(config)};
  const state = config.state;
  const root = document.getElementById('sell');
  const make = (tag, attributes, text) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const named = (path) => path.join(' > ');
  const entry = (path) => config.tree.find((candidate) => named(candidate.path) === named(path));
  const children = (path) => [...new Set(config.tree
    .filter((candidate) => candidate.path.length > path.length && path.every((name, index) => candidate.path[index] === name))
    .map((candidate) => candidate.path[path.length]))];
  const draw = () => {
    root.innerHTML = config.html;
    const find = (selector) => root.querySelector(selector);

    const gotIt = find('[data-testid="ListingTemplatesEducationGotIt"]');
    if (gotIt) gotIt.addEventListener('click', () => find('[data-testid="ListingTemplatesEducation"]').remove());

    // Size: the category's list, shown when the field is tapped.
    const sizeField = find('#size');
    const sizes = find('#sizes');
    const drawSize = () => {
      sizes.replaceChildren();
      const chosen = entry(state.category);
      if (!chosen || chosen.size === null) {
        sizeField.replaceChildren();
        return;
      }
      const input = make('input', { 'data-testid': 'Size', readonly: '', placeholder: 'Select a size' });
      input.value = state.size || '';
      input.addEventListener('click', () => {
        // Each part of the list under its own heading, its options labelled with it.
        sizes.replaceChildren(...config.sizes[chosen.size].flatMap((set) => [
          make('li', { role: 'presentation' }, set.name),
          ...set.labels.map((label) => {
            const option = make('li', { role: 'option', 'data-testid': 'Size-option', 'aria-label': set.name + ' ' + label }, label);
            option.addEventListener('click', () => {
              state.size = label;
              state.sizeSet = set.name;
              input.value = label;
              sizes.replaceChildren();
            });
            return option;
          }),
        ]));
      });
      const label = make('label', {}, 'Size ');
      label.append(input);
      sizeField.replaceChildren(label);
    };

    // Shipping: Mercari's prepaid label, with the label it recommends for the category.
    const prepaid = find('#prepaid');
    const drawPrepaid = () => {
      if (state.shipping !== 'MERCARI') {
        prepaid.replaceChildren();
        return;
      }
      const chosen = entry(state.category);
      const label = make('label', {}, 'Shipping label ');
      label.append(make('input', { 'data-testid': 'SelectShipping', readonly: '', value: chosen ? config.label : '' }));
      const answer = state.freeShipping === 'yes' ? 'Yes' : state.freeShipping === 'no' ? 'No' : 'Choose';
      const question = make('div', { 'data-testid': 'ShippingPayerOption', role: 'button', tabindex: '0' }, 'Offer buyers free shipping? ' + answer);
      const answers = make('ul', { role: 'listbox' });
      question.addEventListener('click', () => {
        answers.replaceChildren(...[['yes', 'Yes', 'FreeShippingYesButton'], ['no', 'No', 'FreeShippingNoButton']].map(([value, text, id]) => {
          const option = make('li', { role: 'option', 'data-testid': id }, text);
          option.addEventListener('click', () => {
            state.freeShipping = value;
            drawPrepaid();
          });
          return option;
        }));
      });
      prepaid.replaceChildren(label, question, answers);
    };
    const ship = (method) => {
      state.shipping = method;
      find('#' + method).checked = true;
      drawPrepaid();
    };
    find('[data-testid="MercariShipping"]').addEventListener('click', () => ship('MERCARI'));
    for (const radio of root.querySelectorAll('input[name="shipping"]')) {
      radio.addEventListener('change', () => ship(radio.value));
    }

    // Category: a dialog of rows, a level at a time, from the top each time it opens.
    const categoryButton = find('[data-testid="SellCategoryFieldButton"]');
    const categories = find('#categories');
    // A category with subcategories lists them and, last, "All <category>", which picks it whole
    // (a department has no such row); a subcategory is picked when its row is.
    const showLevel = (path) => {
      const dialog = make('div', { 'data-testid': 'DialogWrapper', role: 'dialog', 'aria-label': 'Category' });
      for (const name of children(path)) {
        const row = make('button', { type: 'button', 'data-testid': 'CategoryRow' }, name);
        row.addEventListener('click', () => pick([...path, name]));
        dialog.append(row);
      }
      if (path.length >= 2) {
        const whole = make('button', { type: 'button', 'data-testid': 'CategoryRow' }, 'All ' + path[path.length - 1]);
        whole.addEventListener('click', () => choose(path));
        dialog.append(whole);
      }
      categories.replaceChildren(dialog);
    };
    const choose = (path) => {
      const chosen = entry(path);
      state.category = path;
      categoryButton.textContent = named(path);
      if (chosen.size === null || !config.sizes[chosen.size].some((set) => set.name === state.sizeSet && set.labels.includes(state.size))) {
        state.size = null;
        state.sizeSet = null;
      }
      categories.replaceChildren();
      drawSize();
      drawImei();
      drawPrepaid();
    };
    const pick = (path) => {
      if (children(path).length > 0) showLevel(path);
      else choose(path);
    };

    // IMEI: asked only by the categories that want a phone's.
    const imeiField = find('#imei');
    const drawImei = () => {
      const chosen = entry(state.category);
      if (!chosen || !chosen.imei) {
        imeiField.replaceChildren();
        return;
      }
      const label = make('label', {}, 'IMEI ');
      label.append(make('input', { 'data-testid': 'IMEI', placeholder: 'Enter the imei for your device' }));
      imeiField.replaceChildren(label);
    };
    categoryButton.addEventListener('click', () => showLevel([]));

    // Brand: a search of Mercari's list; focusing it starts a new one.
    const brand = find('[data-testid="Brand"]');
    const brands = find('#brands');
    brand.addEventListener('focus', () => {
      brand.value = '';
      brands.replaceChildren();
    });
    brand.addEventListener('input', () => {
      const typed = brand.value.trim().toLowerCase();
      const found = config.brands.filter((name) => typed !== '' && name.toLowerCase().includes(typed));
      brands.replaceChildren(...(typed === ''
        ? []
        : found.length === 0
          ? [make('li', { role: 'option', 'aria-disabled': 'true' }, 'No brands found')]
          : found.map((name) => {
              const option = make('li', { role: 'option', 'data-testid': 'Brand-option' }, name);
              option.addEventListener('click', () => {
                state.brand = name;
                brand.value = name;
                brands.replaceChildren();
              });
              return option;
            })));
    });

    // Smart Pricing: turning it off asks to confirm.
    const smart = find('[data-testid="SmartPricingButton"]');
    const smartDialog = find('#smart-pricing');
    const price = find('[data-testid="Price"]');
    const priceError = find('#price-error');
    const showSmart = () => {
      smart.textContent = state.smartPricing ? 'ON' : 'OFF';
      if (!state.smartPricing) {
        price.removeAttribute('aria-invalid');
        priceError.textContent = '';
      }
    };
    smart.addEventListener('click', () => {
      if (!state.smartPricing) {
        state.smartPricing = true;
        showSmart();
        return;
      }
      const dialog = make('div', { role: 'dialog', 'aria-modal': 'true', style: ${JSON.stringify(OVERLAY)} });
      const box = make('div', { style: ${JSON.stringify(OVERLAY_BOX)} });
      box.append(make('p', {}, 'Turn off Smart Pricing? Your price stays as you set it.'));
      const off = make('button', { type: 'button', 'data-testid': 'SmartPricingTurnOffButton' }, 'Turn off');
      off.addEventListener('click', () => {
        state.smartPricing = false;
        showSmart();
        dialog.remove();
      });
      const keep = make('button', { type: 'button' }, 'Keep it on');
      keep.addEventListener('click', () => dialog.remove());
      box.append(off, keep);
      dialog.append(box);
      smartDialog.replaceChildren(dialog);
    });

    // A change sent the way the page's script sends it.
    const send = (action, fields, photos) => {
      const form = make('form', { method: 'post', action, enctype: 'multipart/form-data', hidden: '' });
      for (const [name, value] of Object.entries(fields)) {
        const input = make('input', { type: 'hidden', name });
        input.value = value;
        form.append(input);
      }
      if (photos) {
        photos.name = 'photos';
        form.append(photos);
      }
      document.body.append(form);
      form.submit();
    };

    // List (Update on the edit page): what the form holds, photos included.
    find('[data-testid="ListButton"]').addEventListener('click', () => {
      if (state.smartPricing) {
        price.setAttribute('aria-invalid', 'true');
        priceError.textContent = 'Smart Pricing needs a lowest price. Set one, or turn Smart Pricing off.';
        return;
      }
      const chosen = entry(state.category);
      const checked = root.querySelector('input[name="condition"]:checked');
      const fields = {
        name: find('[data-testid="Title"]').value,
        description: find('[data-testid="Description"]').value,
        category: named(state.category),
        brand: state.brand || '',
        condition: checked ? checked.value : '',
        size: state.size || '',
        sizeSet: state.sizeSet || '',
        imei: find('[data-testid="IMEI"]') ? find('[data-testid="IMEI"]').value : '',
        shipping: state.shipping,
        shippingLabel: state.shipping === 'MERCARI' && chosen ? config.label : '',
        freeShipping: state.freeShipping || '',
        price: price.value,
      };
      send(config.action, fields, find('[data-testid="SellPhotoInput"]'));
    });

    // Deactivate or Activate: at once, with no confirmation.
    const toggle = find('[data-testid="ActivateDeactivateButton"]');
    if (toggle) toggle.addEventListener('click', () => send(toggle.dataset.action, {}, null));

    drawSize();
    drawImei();
    drawPrepaid();
  };
  setTimeout(draw, ${String(DRAW_MS)});
})();
</script>`;
}

/** JSON for an inline script: `<` escaped, so no value can close the script element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function seconds(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

function copy(item: FakeMercariItem): FakeMercariItem {
  return {
    ...item,
    category: [...item.category],
    photos: [...item.photos],
    listedAt: new Date(item.listedAt),
    updatedAt: new Date(item.updatedAt),
    soldAt: item.soldAt === null ? null : new Date(item.soldAt),
  };
}
