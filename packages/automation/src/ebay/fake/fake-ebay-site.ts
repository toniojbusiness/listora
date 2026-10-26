/**
 * The fake eBay site: a local web app with the pages and flows of eBay's website that the eBay
 * automation adapter uses (docs/features/ebay-automation.md), for its development and tests. No
 * test sends traffic to eBay. It mirrors the adapter's model of eBay: the same paths and form
 * elements, the listing form opened in a category with that category's item specifics (from
 * the fake eBay API's category fixture, so both fakes know the same categories, conditions, and
 * standard sizes) and eBay's validation, listing pages with their times, Seller Hub's end page,
 * active listings, and sold listings with pagination, and eBay's checks (its security check
 * page, a CAPTCHA, a sign-in code, a logged-out session), with fault injection for each. The
 * fake eBay API (`npm run dev:fake-ebay`, in @listora/marketplaces) is a different fake: it
 * serves the Trading and REST APIs, not the website.
 *
 *   GET  /signin/                      the sign-in page (a password field: no session needs it)
 *   POST /signin/                      sign in by hand: any username and password; sets the session cookie
 *   GET  /signin/mfa/verify            a sign-in code step
 *   GET  /splashui/challenge           eBay's security check ("Please verify yourself to continue")
 *   GET  /sh/ovw                       Seller Hub's overview ([data-testid="seller-hub-overview"])
 *   GET  /lstng?mode=AddItem&categoryId=  the listing form in a category; POST lists (multipart)
 *   GET  /lstng?mode=ReviseItem&itemId=   the form of a listing on sale; POST revises it
 *   GET  /lstng?mode=RelistItem&itemId=   the form of an ended or sold listing; POST relists it
 *   GET  /itm/:itemId                  a listing's page (title, price, status, its times)
 *   GET  /sh/lst/end?itemId=           the end page; POST ends the listing
 *   GET  /sh/lst/active                the seller's active listings; `?offset=N`, 10 a page
 *   GET  /sh/lst/sold                  the seller's sold listings; `?offset=N`, 10 a page
 *   GET  /photos/<name>.jpg            a photo, standing in for Listora's image CDN (no session)
 *
 * Every page except the sign-in pages, the security check, and photos needs the session cookie;
 * without a valid one it redirects to the sign-in page. A listing's page shows when it was last
 * updated, ended, or sold, to the second, and each change is at least a second after the last
 * (automated changes are seconds apart), so the newest time serves as a revision; a stale read
 * serves the listing as it was before its latest change. An ended listing stays readable; a
 * relist lists it again under a new item number. An unknown item number is a plain 404.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SessionCookie } from '@listora/connections';
import {
  fakeEbayCategory,
  type FakeEbayAspect,
  type FakeEbayCategory,
  type SizeAspect,
} from '@listora/marketplaces';

import {
  cookieValue,
  delay,
  escape,
  readForm,
  redirect,
  type Reply,
  type SubmittedForm,
} from '../../fake-site/http.ts';
import { EBAY_CONDITION_LABELS, conditionList } from '../conditions.ts';
import type { EbayFormMode } from '../site.ts';

export type FakeEbaySiteAction =
  'create' | 'update' | 'relist' | 'end' | 'read' | 'listings' | 'sold' | 'health' | 'form';

export type FakeEbaySiteFault =
  /** A redirect to eBay's security check page (`/splashui/challenge`). */
  | { type: 'bot_check' }
  /** The page, with a CAPTCHA widget over it (status 200). */
  | { type: 'captcha' }
  /** A redirect to a sign-in code step. */
  | { type: 'login_challenge' }
  /** The session is invalidated, and the page redirects to the sign-in page. */
  | { type: 'session_expired' }
  | { type: 'rate_limited'; retryAfterSeconds?: number }
  /** A 500 page; with `afterApply`, the change was made first. */
  | { type: 'server_error'; afterApply?: boolean }
  /** A form submission comes back with this message; nothing is applied. */
  | { type: 'reject'; message: string }
  /** The answer comes after `delayMs`; with `afterApply`, the change is made at once. */
  | { type: 'slow'; delayMs: number; afterApply: boolean }
  /** A read serves the listing as it was before its latest change. */
  | { type: 'stale_read' }
  /** The page without the elements the adapter reads, as after a site redesign. */
  | { type: 'redesigned' };

export interface FakeEbaySiteFaultRule {
  action: FakeEbaySiteAction;
  fault: FakeEbaySiteFault;
  /** How many matching requests get it (default 1). */
  times?: number;
}

export type FakeEbaySiteStatus = 'active' | 'ended' | 'sold';

export interface FakeEbaySiteListing {
  itemId: string;
  /** The seller whose session listed it; Seller Hub shows only their own. */
  seller: string;
  status: FakeEbaySiteStatus;
  title: string;
  /** The Custom label (SKU). */
  sku: string | null;
  categoryId: string;
  conditionId: number;
  conditionDescription: string | null;
  /** The description as the editor's HTML view got it. */
  descriptionHtml: string;
  priceCents: number;
  itemSpecifics: { name: string; values: string[] }[];
  /** Uploaded photo file names, in the order the form sent them. */
  photos: string[];
  /** The seller's shipping policy the listing was listed with. */
  shipping: string;
  listedAt: Date;
  /** The last revision; `null` for a listing never changed since it was listed. */
  updatedAt: Date | null;
  endedAt: Date | null;
  soldAt: Date | null;
  orderId: string | null;
  /** The item number a relist gave it again under. */
  relistedAs: string | null;
}

export interface FakeEbaySiteRequest {
  method: string;
  path: string;
  action: FakeEbaySiteAction | null;
  at: number;
  fault: FakeEbaySiteFault['type'] | null;
  status: number;
}

export interface FakeEbaySiteOptions {
  /** Listings per page of Seller Hub's lists (default 10). */
  pageSize?: number;
  /**
   * The shipping policy the form starts with, as eBay keeps the seller's business policies
   * (default "Standard shipping"); `null` for a seller who has set none up.
   */
  shippingPolicy?: string | null;
}

interface StoredListing {
  current: FakeEbaySiteListing;
  previous: FakeEbaySiteListing | null;
}

interface Session {
  seller: string;
}

interface Route {
  method: 'GET' | 'POST';
  action: FakeEbaySiteAction;
  /** The listing form's mode, for `/lstng`. */
  mode: EbayFormMode | null;
  itemId: string | null;
}

const SESSION_COOKIE = 'fake_ebay_session';
const PHOTO_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const LIMITS = { title: 80, photos: 24, minCents: 99 };

export class FakeEbaySite {
  readonly #server: Server;
  readonly #pageSize: number;
  readonly #shippingPolicy: string | null;
  readonly #listings = new Map<string, StoredListing>();
  readonly #sessions = new Map<string, Session>();
  readonly #faults: (FakeEbaySiteFaultRule & { remaining: number })[] = [];
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly requests: FakeEbaySiteRequest[] = [];
  #sequence = 0;
  #url = '';

  private constructor(options: FakeEbaySiteOptions) {
    this.#pageSize = options.pageSize ?? 10;
    this.#shippingPolicy =
      options.shippingPolicy === undefined ? 'Standard shipping' : options.shippingPolicy;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end(error instanceof Error ? error.message : 'error');
        }
      });
    });
  }

  static async start(port = 0, options: FakeEbaySiteOptions = {}): Promise<FakeEbaySite> {
    const site = new FakeEbaySite(options);
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

  /** The cookie a seller's signed-in browser holds, as the app would hand it to Listora. */
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

  inject(rule: FakeEbaySiteFaultRule): void {
    this.#faults.push({ ...rule, remaining: rule.times ?? 1 });
  }

  clearFaults(): void {
    this.#faults.length = 0;
  }

  listings(): FakeEbaySiteListing[] {
    return [...this.#listings.values()].map((stored) => copy(stored.current));
  }

  listing(itemId: string): FakeEbaySiteListing | undefined {
    const stored = this.#listings.get(itemId);
    return stored === undefined ? undefined : copy(stored.current);
  }

  /** The listings whose Custom label is this SKU (ended and sold ones included). */
  listingsWithSku(sku: string): FakeEbaySiteListing[] {
    return this.listings().filter((listing) => listing.sku === sku);
  }

  /** Lists an item directly, as the seller once did by hand; returns its item number. */
  seed(
    listing: Partial<Omit<FakeEbaySiteListing, 'itemId'>> & { title: string; priceCents: number },
  ): string {
    const itemId = this.#newItemId();
    this.#listings.set(itemId, {
      current: {
        seller: 'fake-seller',
        status: 'active',
        sku: null,
        categoryId: '15687',
        conditionId: 3000,
        conditionDescription: null,
        descriptionHtml: 'Listed by hand.',
        itemSpecifics: [{ name: 'Brand', values: ['Unbranded'] }],
        photos: ['photo.jpg'],
        shipping: 'Standard shipping',
        listedAt: seconds(new Date()),
        updatedAt: null,
        endedAt: null,
        soldAt: null,
        orderId: null,
        relistedAs: null,
        ...listing,
        itemId,
      },
      previous: null,
    });
    return itemId;
  }

  /** A buyer buys the listing: it sold out (Seller Hub's sold listings); returns the order. */
  sell(itemId: string, soldAt = new Date()): string {
    this.#sequence += 1;
    const sequence = String(this.#sequence).padStart(10, '0');
    const orderId = `12-${sequence.slice(0, 5)}-${sequence.slice(5)}`;
    this.#change(this.#stored(itemId), { status: 'sold', soldAt: seconds(soldAt), orderId });
    return orderId;
  }

  /** eBay no longer serves the listing at all: its page is a plain 404. */
  forget(itemId: string): void {
    this.#listings.delete(itemId);
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
    const record: FakeEbaySiteRequest = {
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

    if (url.pathname === '/signin/' || url.pathname === '/signin') {
      if (method === 'POST') {
        // The seller signs in by hand, as on the app's Link accounts screen in development: any
        // username with a password starts a session as that seller.
        const form = await readForm(request);
        const seller = form.text('username');
        if (seller !== '' && form.text('password') !== '') {
          const { value } = this.issueSession(seller);
          send({
            status: 303,
            headers: {
              location: '/sh/ovw',
              'set-cookie': `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
            },
          });
          return;
        }
      }
      send({ status: 200, body: page('Sign in or Register | eBay', signInForm()) });
      return;
    }
    if (url.pathname === '/signin/mfa/verify') {
      send({ status: 200, body: page('Verify it’s you | eBay', verifyForm()) });
      return;
    }
    if (url.pathname === '/splashui/challenge') {
      send({ status: 200, body: securityCheckPage() });
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
    const route = matchRoute(method, url);
    record.action = route?.action ?? null;
    if (session === undefined || token === undefined) {
      send(redirect('/signin/'));
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
    fault: FakeEbaySiteFault | undefined,
  ): Promise<Reply> {
    switch (fault?.type) {
      case 'bot_check':
        return redirect(
          `/splashui/challenge?ap=1&appName=orch&ru=${encodeURIComponent(url.pathname)}`,
        );
      case 'login_challenge':
        return redirect('/signin/mfa/verify');
      case 'session_expired':
        this.#sessions.delete(token);
        return redirect('/signin/');
      case 'rate_limited':
        return {
          status: 429,
          headers:
            fault.retryAfterSeconds === undefined
              ? {}
              : { 'retry-after': String(fault.retryAfterSeconds) },
          body: page('eBay', '<p>Too many requests. Try again later.</p>'),
        };
      case 'redesigned':
        return { status: 200, body: page('eBay', '<main><h1>Something new</h1></main>') };
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
      return refused(
        fault.message,
        route,
        url,
        this.#storedListing(route.itemId),
        this.#shippingPolicy,
      );
    }
    const apply = (): Reply => this.#apply(route, url, form, session, fault);
    if (fault?.type === 'server_error') {
      if (fault.afterApply === true) apply();
      return { status: 500, body: page('eBay', '<p>Sorry, something went wrong.</p>') };
    }
    if (fault?.type === 'slow') {
      const early = fault.afterApply ? apply() : undefined;
      await delay(fault.delayMs, this.#timers);
      return early ?? apply();
    }
    const reply = apply();
    if (fault?.type === 'captcha' && reply.body !== undefined) {
      // A CAPTCHA widget over the page eBay served.
      return { ...reply, body: reply.body.replace('<body>', `<body>${captchaWidget()}`) };
    }
    return reply;
  }

  #apply(
    route: Route,
    url: URL,
    form: SubmittedForm | null,
    session: Session,
    fault: FakeEbaySiteFault | undefined,
  ): Reply {
    switch (route.action) {
      case 'health':
        return {
          status: 200,
          body: page(
            'Seller Hub | eBay',
            `<main data-testid="seller-hub-overview"><h1>Seller Hub</h1><p data-testid="seller-user-id">${escape(session.seller)}</p></main>`,
          ),
        };
      case 'form':
        return this.#form(route, url, session);
      case 'create': {
        const category = fakeEbayCategory(url.searchParams.get('categoryId') ?? '');
        if (category === undefined) return refused('Select a category.', route, url, null, null);
        const fields = this.#fields(form, category, null);
        if (typeof fields === 'string')
          return refused(fields, route, url, null, this.#shippingPolicy);
        const itemId = this.#newItemId();
        this.#listings.set(itemId, {
          current: newListing(itemId, session.seller, fields),
          previous: null,
        });
        return redirect(`/itm/${itemId}`);
      }
      case 'update':
        return this.#owned(route.itemId, session, (stored) => {
          if (stored.current.status !== 'active') return redirect(`/itm/${stored.current.itemId}`);
          const category = fakeEbayCategory(
            url.searchParams.get('categoryId') ?? stored.current.categoryId,
          );
          if (category === undefined)
            return refused('Select a category.', route, url, stored, null);
          const fields = this.#fields(form, category, stored.current);
          if (typeof fields === 'string') {
            return refused(fields, route, url, stored, this.#shippingPolicy);
          }
          this.#change(stored, { ...fields, updatedAt: null });
          return redirect(`/itm/${stored.current.itemId}`);
        });
      case 'relist':
        return this.#owned(route.itemId, session, (stored) => {
          if (stored.current.status === 'active') return redirect(`/itm/${stored.current.itemId}`);
          const category = fakeEbayCategory(
            url.searchParams.get('categoryId') ?? stored.current.categoryId,
          );
          if (category === undefined)
            return refused('Select a category.', route, url, stored, null);
          const fields = this.#fields(form, category, stored.current);
          if (typeof fields === 'string') {
            return refused(fields, route, url, stored, this.#shippingPolicy);
          }
          const itemId = this.#newItemId();
          this.#listings.set(itemId, {
            current: newListing(itemId, session.seller, fields),
            previous: null,
          });
          stored.current = { ...stored.current, relistedAs: itemId };
          return redirect(`/itm/${itemId}`);
        });
      case 'end':
        return this.#owned(route.itemId, session, (stored) => {
          if (stored.current.status === 'active' && form?.text('reason') === 'NotAvailable') {
            this.#change(stored, { status: 'ended', endedAt: null });
          }
          return redirect(`/itm/${stored.current.itemId}`);
        });
      case 'read': {
        const stored = this.#listings.get(route.itemId ?? '');
        if (stored === undefined) return notFound();
        const shown =
          fault?.type === 'stale_read' && stored.previous !== null
            ? stored.previous
            : stored.current;
        return { status: 200, body: page(`${shown.title} | eBay`, itemPage(shown)) };
      }
      case 'listings': {
        const { rows, more, next } = this.#pageOf(
          url,
          this.listings()
            .filter((listing) => listing.seller === session.seller && listing.status === 'active')
            .sort(
              (a, b) =>
                b.listedAt.getTime() - a.listedAt.getTime() || b.itemId.localeCompare(a.itemId),
            ),
        );
        return {
          status: 200,
          body: page('Active listings | Seller Hub | eBay', activeListingsPage(rows, more, next)),
        };
      }
      case 'sold': {
        const { rows, more, next } = this.#pageOf(
          url,
          this.listings()
            .filter((listing) => listing.seller === session.seller && listing.status === 'sold')
            .sort((a, b) => (b.soldAt?.getTime() ?? 0) - (a.soldAt?.getTime() ?? 0)),
        );
        return {
          status: 200,
          body: page('Sold | Seller Hub | eBay', soldListingsPage(rows, more, next)),
        };
      }
    }
  }

  /** The listing form for the route's mode, or the end page; what eBay shows instead otherwise. */
  #form(route: Route, url: URL, session: Session): Reply {
    if (route.mode === null) {
      // The end page.
      return this.#owned(route.itemId, session, (stored) =>
        stored.current.status === 'active'
          ? { status: 200, body: page('End your listing | eBay', endPage(stored.current)) }
          : redirect(`/itm/${stored.current.itemId}`),
      );
    }
    const categoryId = url.searchParams.get('categoryId');
    if (route.mode === 'AddItem') {
      const category = fakeEbayCategory(categoryId ?? '');
      // Without a category eBay asks what the seller is selling first.
      if (category === undefined)
        return { status: 200, body: page('List an item | eBay', prelistPage()) };
      return {
        status: 200,
        body: page('List an item | eBay', listingForm(url, category, null, this.#shippingPolicy)),
      };
    }
    const wantsActive = route.mode === 'ReviseItem';
    return this.#owned(route.itemId, session, (stored) => {
      if ((stored.current.status === 'active') !== wantsActive) {
        return redirect(`/itm/${stored.current.itemId}`);
      }
      const category = fakeEbayCategory(categoryId ?? stored.current.categoryId);
      if (category === undefined) return { status: 200, body: page('eBay', prelistPage()) };
      return {
        status: 200,
        body: page(
          wantsActive ? 'Revise your listing | eBay' : 'Relist your item | eBay',
          listingForm(url, category, stored.current, this.#shippingPolicy),
        ),
      };
    });
  }

  /** The form's fields, or eBay's message for the first problem. */
  #fields(
    form: SubmittedForm | null,
    category: FakeEbayCategory,
    existing: FakeEbaySiteListing | null,
  ): ListingFields | string {
    const text = (name: string): string => form?.text(name) ?? '';
    const photos = form?.fileNames('photos') ?? [];
    const keptPhotos = photos.length === 0 && existing !== null ? existing.photos : photos;
    if (keptPhotos.length === 0) return 'Add at least one photo.';
    if (keptPhotos.length > LIMITS.photos) return 'You can add up to 24 photos.';
    const title = text('title');
    if (title === '') return 'Add a title.';
    if (title.length > LIMITS.title) return 'Titles can be up to 80 characters.';
    const conditionId = Number(text('condition'));
    if (!category.conditionIds.includes(conditionId)) return 'Select a condition.';

    const specifics = itemSpecificsOf(form, category);
    for (const aspect of category.aspects) {
      const values = specifics.find((specific) => specific.name === aspect.name)?.values ?? [];
      if (aspect.required && values.length === 0) return `Add ${aspect.name} in item specifics.`;
      const invalid =
        aspect.mode === 'SELECTION_ONLY'
          ? values.find((value) => !aspect.values.includes(value))
          : undefined;
      if (invalid !== undefined) {
        return `${invalid} is not a valid value for ${aspect.name}. Select a value from the available options.`;
      }
    }
    // Browsers send a textarea's line breaks as CRLF.
    const descriptionHtml = text('description').replaceAll('\r\n', '\n');
    if (descriptionHtml === '') return 'Add a description.';
    const amount = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text('price'));
    if (amount?.[1] === undefined) return 'Enter a price.';
    const priceCents = Number(amount[1]) * 100 + Number((amount[2] ?? '0').padEnd(2, '0'));
    if (priceCents < LIMITS.minCents) return 'Enter a price of at least $0.99.';
    const shipping = existing?.shipping ?? this.#shippingPolicy;
    if (shipping === null) return 'Add shipping details before you list.';
    const sku = text('customLabel');
    const conditionDescription = text('conditionDescription').replaceAll('\r\n', '\n');
    return {
      title,
      sku: sku === '' ? null : sku,
      categoryId: category.categoryId,
      conditionId,
      conditionDescription: conditionDescription === '' ? null : conditionDescription,
      descriptionHtml,
      priceCents,
      itemSpecifics: specifics,
      photos: keptPhotos,
      shipping,
    };
  }

  #pageOf(
    url: URL,
    rows: FakeEbaySiteListing[],
  ): { rows: FakeEbaySiteListing[]; more: boolean; next: number } {
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0') || 0);
    return {
      rows: rows.slice(offset, offset + this.#pageSize),
      more: rows.length > offset + this.#pageSize,
      next: offset + this.#pageSize,
    };
  }

  #owned(itemId: string | null, session: Session, act: (stored: StoredListing) => Reply): Reply {
    const stored = this.#storedListing(itemId);
    if (stored?.current.seller !== session.seller) return notFound();
    return act(stored);
  }

  #storedListing(itemId: string | null): StoredListing | undefined {
    return itemId === null ? undefined : this.#listings.get(itemId);
  }

  #stored(itemId: string): StoredListing {
    const stored = this.#listings.get(itemId);
    if (stored === undefined) throw new Error(`no listing ${itemId}`);
    return stored;
  }

  /**
   * Changes a listing, stamping the change's time: a revise sets when it was last updated, and
   * an end when it ended, each at least a second after the listing's newest time, as automated
   * changes are seconds apart. A sale keeps the time it is given.
   */
  #change(stored: StoredListing, change: Partial<FakeEbaySiteListing>): void {
    stored.previous = copy(stored.current);
    const newest = Math.max(
      stored.current.listedAt.getTime(),
      stored.current.updatedAt?.getTime() ?? 0,
      stored.current.endedAt?.getTime() ?? 0,
      stored.current.soldAt?.getTime() ?? 0,
    );
    const at = new Date(Math.max(seconds(new Date()).getTime(), newest + 1_000));
    const stamped: Partial<FakeEbaySiteListing> = { ...change };
    if ('updatedAt' in change) stamped.updatedAt = at;
    if ('endedAt' in change) stamped.endedAt = at;
    stored.current = { ...stored.current, ...stamped };
  }

  /** eBay's item numbers: 12 digits. */
  #newItemId(): string {
    this.#sequence += 1;
    return String(326_000_000_000 + this.#sequence);
  }

  #takeFault(action: FakeEbaySiteAction): FakeEbaySiteFault | undefined {
    const rule = this.#faults.find(
      (candidate) => candidate.action === action && candidate.remaining > 0,
    );
    if (rule === undefined) return undefined;
    rule.remaining -= 1;
    return rule.fault;
  }
}

// Routing -------------------------------------------------------------------------------------

const FORM_MODES = { AddItem: 'create', ReviseItem: 'update', RelistItem: 'relist' } as const;

function matchRoute(method: string, url: URL): Route | null {
  const path = url.pathname;
  const get = method === 'GET';
  const post = method === 'POST';
  const itemId = url.searchParams.get('itemId');
  if (get && path === '/sh/ovw') return { method, action: 'health', mode: null, itemId: null };
  if (get && path === '/sh/lst/active') {
    return { method, action: 'listings', mode: null, itemId: null };
  }
  if (get && path === '/sh/lst/sold') return { method, action: 'sold', mode: null, itemId: null };
  if (path === '/sh/lst/end' && itemId !== null) {
    if (get) return { method, action: 'form', mode: null, itemId };
    if (post) return { method, action: 'end', mode: null, itemId };
  }
  if (path === '/lstng') {
    const mode = url.searchParams.get('mode');
    if (mode !== 'AddItem' && mode !== 'ReviseItem' && mode !== 'RelistItem') return null;
    if (mode !== 'AddItem' && itemId === null) return null;
    if (get) return { method, action: 'form', mode, itemId };
    if (post) return { method, action: FORM_MODES[mode], mode, itemId };
  }
  const item = /^\/itm\/(\d+)$/.exec(path)?.[1];
  if (get && item !== undefined) return { method, action: 'read', mode: null, itemId: item };
  return null;
}

function notFound(): Reply {
  return {
    status: 404,
    body: page(
      'Error Page | eBay',
      '<main data-testid="x-page-missing"><h1>We looked everywhere.</h1><p>Looks like this page is missing.</p></main>',
    ),
  };
}

/** The form again, with eBay's message; nothing applied. */
function refused(
  message: string,
  route: Route,
  url: URL,
  stored: StoredListing | undefined | null,
  shippingPolicy: string | null,
): Reply {
  const category = fakeEbayCategory(
    url.searchParams.get('categoryId') ?? stored?.current.categoryId ?? '',
  );
  const formUrl = new URL(url);
  if (route.mode !== null) formUrl.searchParams.set('mode', route.mode);
  return {
    status: 422,
    body: page(
      'List an item | eBay',
      `<p data-testid="listing-form__error" role="alert">${escape(message)}</p>${
        category === undefined
          ? ''
          : listingForm(formUrl, category, stored?.current ?? null, shippingPolicy)
      }`,
    ),
  };
}

// Forms ---------------------------------------------------------------------------------------

type ListingFields = Pick<
  FakeEbaySiteListing,
  | 'title'
  | 'sku'
  | 'categoryId'
  | 'conditionId'
  | 'conditionDescription'
  | 'descriptionHtml'
  | 'priceCents'
  | 'itemSpecifics'
  | 'photos'
  | 'shipping'
>;

function newListing(itemId: string, seller: string, fields: ListingFields): FakeEbaySiteListing {
  return {
    itemId,
    seller,
    status: 'active',
    ...fields,
    listedAt: seconds(new Date()),
    updatedAt: null,
    endedAt: null,
    soldAt: null,
    orderId: null,
    relistedAs: null,
  };
}

/**
 * The item specifics the form sent: the category's fields, then the custom ones (a later one
 * with the same name wins). Several values are separated by commas.
 */
function itemSpecificsOf(
  form: SubmittedForm | null,
  category: FakeEbayCategory,
): { name: string; values: string[] }[] {
  const byName = new Map<string, { name: string; values: string[] }>();
  const add = (name: string, value: string): void => {
    const values = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (name === '' || values.length === 0) return;
    const known = category.aspects.find(
      (aspect) => aspect.name.toLowerCase() === name.toLowerCase(),
    );
    const own = known?.name ?? name;
    byName.set(own.toLowerCase(), { name: own, values });
  };
  for (const aspect of category.aspects)
    add(aspect.name, form?.text(`aspect:${aspect.name}`) ?? '');
  for (let index = 0; form !== null && form.text(`customName${String(index)}`) !== ''; index += 1) {
    add(form.text(`customName${String(index)}`), form.text(`customValue${String(index)}`));
  }
  return [...byName.values()];
}

// Pages ---------------------------------------------------------------------------------------

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body>${body}</body></html>`;
}

function signInForm(): string {
  return `<main><h1>Sign in to your account</h1><form method="post" action="/signin/"><input name="username" placeholder="Email or username"><input name="password" type="password"><button type="submit">Sign in</button></form></main>`;
}

function verifyForm(): string {
  return `<main><h1>Verify it’s you</h1><p>Enter the code we sent to your phone.</p><input name="code" inputmode="numeric"><button type="submit">Continue</button></main>`;
}

/** eBay's security check (no frame or script: nothing leaves this machine). */
function securityCheckPage(): string {
  return page(
    'Security Measure',
    '<main><h1>Please verify yourself to continue</h1><p>To keep eBay a safe place to buy and sell, we will occasionally ask you to verify yourself.</p></main>',
  );
}

function captchaWidget(): string {
  return `<div class="h-captcha" data-sitekey="fake-site-key" style="width:304px;height:78px;border:1px solid #ccc">I am human</div>`;
}

function prelistPage(): string {
  return `<main data-testid="prelist"><h1>Start your listing</h1><p>Tell us what you're selling.</p><input name="keyword"></main>`;
}

function dollars(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString('en-US');
  return `${whole}.${String(cents % 100).padStart(2, '0')}`;
}

function itemPage(listing: FakeEbaySiteListing): string {
  const notice =
    listing.status === 'sold' && listing.soldAt !== null
      ? `<div data-testid="x-sold-notice">This item sold on ${formatEbayTime(listing.soldAt)}.</div>`
      : listing.status === 'ended'
        ? `<div data-testid="x-ended-notice">This listing was ended by the seller on ${formatEbayTime(listing.endedAt ?? listing.listedAt)} because the item is no longer available.</div>`
        : '';
  const updated =
    listing.updatedAt === null
      ? ''
      : `<span data-testid="x-last-updated">Last updated on ${formatEbayTime(listing.updatedAt)}</span> <a href="#">View all revisions</a>`;
  const specifics = listing.itemSpecifics
    .map(
      (specific) =>
        `<dt>${escape(specific.name)}</dt><dd>${escape(specific.values.join(', '))}</dd>`,
    )
    .join('');
  return `<main data-testid="x-item-page">
${notice}
<h1 data-testid="x-item-title">${escape(listing.title)}</h1>
<div data-testid="x-price-primary">US $${dollars(listing.priceCents)}</div>
<section><h2>About this item</h2>
<p><span data-testid="x-item-number">eBay item number: ${listing.itemId}</span> ${updated}</p>
<dl>${specifics}</dl></section>
<iframe id="desc_ifr" title="Item description from the seller" srcdoc="${escape(listing.descriptionHtml)}"></iframe>
<p>Seller: <span data-testid="seller-user-id">${escape(listing.seller)}</span></p>
</main>`;
}

function endPage(listing: FakeEbaySiteListing): string {
  return `<main><h1>End your listing</h1><p>${escape(listing.title)} (${listing.itemId})</p>
<form method="post" action="/sh/lst/end?itemId=${listing.itemId}" data-testid="end-listing">
<fieldset><legend>Why are you ending this listing?</legend>
<label><input type="radio" name="reason" value="NotAvailable"> The item is no longer available</label>
<label><input type="radio" name="reason" value="Incorrect"> There's an error in the listing</label>
<label><input type="radio" name="reason" value="LostOrBroken"> The item was lost or broken</label>
</fieldset>
<button type="submit" data-testid="end-listing__submit">End listing</button></form></main>`;
}

function pagination(path: string, more: boolean, next: number): string {
  return more
    ? `<a data-testid="pagination__next" href="${path}?offset=${String(next)}">Next</a>`
    : '';
}

function activeListingsPage(
  rows: readonly FakeEbaySiteListing[],
  more: boolean,
  next: number,
): string {
  const items = rows
    .map(
      (listing) =>
        `<tr data-testid="listing-row" data-item-id="${listing.itemId}"><td><a data-testid="listing-row__title" href="/itm/${listing.itemId}">${escape(listing.title)}</a></td><td data-testid="listing-row__custom-label">${escape(listing.sku ?? '--')}</td><td data-testid="listing-row__price">$${dollars(listing.priceCents)}</td></tr>`,
    )
    .join('');
  return `<main><h1>Active listings</h1><table data-testid="active-listings"><tbody>${items}</tbody></table>${pagination('/sh/lst/active', more, next)}</main>`;
}

function soldListingsPage(
  rows: readonly FakeEbaySiteListing[],
  more: boolean,
  next: number,
): string {
  const items = rows
    .map(
      (listing) =>
        `<tr data-testid="sold-row" data-item-id="${listing.itemId}"><td><a href="/itm/${listing.itemId}">${escape(listing.title)}</a></td><td data-testid="sold-row__order">Order number ${listing.orderId ?? ''}</td><td data-testid="sold-row__price">$${dollars(listing.priceCents)}</td><td data-testid="sold-row__date">Sold ${listing.soldAt === null ? '' : formatEbayTime(listing.soldAt)}</td><td data-testid="buyer">a_buyer</td><td data-testid="shipping-address">1 Buyer Street</td></tr>`,
    )
    .join('');
  return `<main><h1>Sold</h1><table data-testid="sold-listings"><tbody>${items}</tbody></table>${pagination('/sh/lst/sold', more, next)}</main>`;
}

/**
 * The listing form, with the small script that adds a custom item specific: each one gets a
 * name and a value field (`customName<n>`, `customValue<n>`).
 */
function listingForm(
  url: URL,
  category: FakeEbayCategory,
  listing: FakeEbaySiteListing | null,
  shippingPolicy: string | null,
): string {
  const mode = url.searchParams.get('mode') ?? 'AddItem';
  const action = `/lstng?${url.searchParams.toString()}`;
  const value = (text: string | null | undefined): string => escape(text ?? '');
  const own = new Map(
    (listing?.itemSpecifics ?? []).map((specific) => [specific.name.toLowerCase(), specific]),
  );
  const fields = category.aspects
    .map((aspect, index) => itemSpecificField(aspect, index, own.get(aspect.name.toLowerCase())))
    .join('');
  const known = new Set(category.aspects.map((aspect) => aspect.name.toLowerCase()));
  const custom = (listing?.itemSpecifics ?? [])
    .filter((specific) => !known.has(specific.name.toLowerCase()))
    .map((specific, index) => customField(index, specific.name, specific.values.join(', ')))
    .join('');
  const kind = conditionList(categoryTraitsOf(category));
  const conditions = category.conditionIds
    .map(
      (id) =>
        `<option value="${String(id)}"${listing?.conditionId === id ? ' selected' : ''}>${escape(EBAY_CONDITION_LABELS[kind][id] ?? String(id))}</option>`,
    )
    .join('');
  const shipping = listing?.shipping ?? shippingPolicy;
  return `<form method="post" action="${escape(action)}" enctype="multipart/form-data" data-testid="listing-form">
<p data-testid="listing-form__category" data-category-id="${category.categoryId}">Category: ${escape(category.categoryName)} in ${escape(category.ancestors[0] ?? '')}</p>
<label>Photos <input type="file" name="photos" multiple accept="image/jpeg"></label>
<label>Title <input name="title" maxlength="80" value="${value(listing?.title)}"></label>
<label>Custom label (SKU) <input name="customLabel" value="${value(listing?.sku)}"></label>
<fieldset data-testid="item-specifics"><legend>Item specifics</legend>
${fields}
<div data-testid="custom-item-specifics">${custom}</div>
<button type="button" data-testid="add-item-specific">Add item specific</button>
</fieldset>
<label>Condition <select name="condition"><option value="">Select</option>${conditions}</select></label>
<label>Condition description <textarea name="conditionDescription">${value(listing?.conditionDescription)}</textarea></label>
<label>Description (HTML) <textarea name="description">${value(listing?.descriptionHtml)}</textarea></label>
<label>Buy It Now price $<input name="price" inputmode="decimal" value="${listing === null ? '' : dollars(listing.priceCents).replaceAll(',', '')}"></label>
<p data-testid="listing-form__shipping">Shipping: ${escape(shipping ?? 'Add shipping details')}</p>
<button type="submit" data-testid="listing-form__submit">${mode === 'ReviseItem' ? 'Revise it' : 'List it'}</button>
</form>
<script>
(() => {
  const list = document.querySelector('[data-testid="custom-item-specifics"]');
  document.querySelector('[data-testid="add-item-specific"]').addEventListener('click', () => {
    const index = list.querySelectorAll('[data-testid="custom-item-specific"]').length;
    const row = document.createElement('div');
    row.dataset.testid = 'custom-item-specific';
    const field = (name, label) => {
      const input = Object.assign(document.createElement('input'), { name: name + index });
      input.dataset.field = label;
      input.setAttribute('aria-label', label);
      return input;
    };
    row.append(field('customName', 'name'), field('customValue', 'value'));
    list.append(row);
  });
})();
</script>`;
}

function itemSpecificField(
  aspect: FakeEbayAspect,
  index: number,
  current: { values: string[] } | undefined,
): string {
  const options = aspect.values
    .map((option) => `<option value="${escape(option)}"></option>`)
    .join('');
  return `<div data-testid="item-specific" data-name="${escape(aspect.name)}"><label>${escape(aspect.name)}${aspect.required ? ' (required)' : ''} <input name="aspect:${escape(aspect.name)}" list="aspect-${String(index)}" value="${escape(current?.values.join(', ') ?? '')}"></label><datalist id="aspect-${String(index)}">${options}</datalist></div>`;
}

function customField(index: number, name: string, value: string): string {
  return `<div data-testid="custom-item-specific"><input name="customName${String(index)}" data-field="name" aria-label="name" value="${escape(name)}"><input name="customValue${String(index)}" data-field="value" aria-label="value" value="${escape(value)}"></div>`;
}

/** Which size item specific the fake category takes, for its condition names. */
function categoryTraitsOf(category: FakeEbayCategory): SizeAspect {
  if (category.aspects.some((aspect) => aspect.name === 'US Shoe Size')) return 'shoes';
  if (category.aspects.some((aspect) => aspect.name === 'Size')) return 'clothing';
  return 'none';
}

/** A time as eBay shows it, in Pacific time: `Oct 25, 2026 09:12:45 PDT`. */
export function formatEbayTime(date: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const part = (name: string): string => parts[name] ?? '';
  return `${part('month')} ${part('day')}, ${part('year')} ${part('hour')}:${part('minute')}:${part('second')} ${part('timeZoneName')}`;
}

function seconds(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

function copy(listing: FakeEbaySiteListing): FakeEbaySiteListing {
  const date = (value: Date | null): Date | null => (value === null ? null : new Date(value));
  return {
    ...listing,
    itemSpecifics: listing.itemSpecifics.map((specific) => ({
      name: specific.name,
      values: [...specific.values],
    })),
    photos: [...listing.photos],
    listedAt: new Date(listing.listedAt),
    updatedAt: date(listing.updatedAt),
    endedAt: date(listing.endedAt),
    soldAt: date(listing.soldAt),
  };
}
