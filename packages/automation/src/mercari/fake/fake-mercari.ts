/**
 * The fake Mercari site: a local web app with the pages and flows of Mercari's US site that
 * the Mercari automation adapter uses (docs/mercari.md), for its development and tests. No test
 * sends traffic to Mercari. It mirrors the adapter's model of Mercari: the same paths, the same
 * page elements, the sell form's level-by-level category picker, brand search, size lists,
 * and validation, the edit page's Deactivate and Activate with their confirmation dialogs, the
 * seller's listing tabs, and Mercari's checks (Cloudflare's interstitial and Turnstile widget,
 * a CAPTCHA, a login code, a logged-out session), with fault injection for each.
 *
 *   GET  /login/                      the login page (a password field: no session needs it)
 *   GET  /login/verify/               a login code step
 *   GET  /mypage/                     the seller's account ([data-testid="MyPage"])
 *   GET  /sell/                       the sell form; POST /sell/ lists (multipart, photos)
 *   GET  /us/item/:id/                a listing's page (name, price, description, last update)
 *   GET  /sell/edit/:id/              the edit form; POST saves it
 *   POST /sell/edit/:id/deactivate    deactivate (after the page's confirmation dialog)
 *   POST /sell/edit/:id/activate      activate an inactive listing
 *   GET  /mypage/listings/:tab/       active, inactive, in_progress, sold; `?page=N`, 10 a page
 *   GET  /photos/<name>.jpg           a photo, standing in for Listora's image CDN (no session)
 *
 * Every page except the login pages and photos needs the session cookie; without a valid one it
 * redirects to the login page. A listing's last-updated time grows by at least a second with
 * every change (automated changes are seconds apart), so it serves as a revision; a stale read
 * serves the listing as it was before its latest change. A deleted listing shows Mercari's
 * "deleted" notice; an unknown id a plain "not found" page.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SessionCookie } from '@listora/connections';

import { mappedMercariCategories, type MercariSizeKind } from '../categories.ts';
import { MERCARI_CONDITIONS } from '../conditions.ts';
import { SHIPPING_WEIGHTS, weightLabel } from '../shipping.ts';
import type { MercariListingTab } from '../site.ts';

export type FakeMercariAction =
  'create' | 'update' | 'end' | 'relist' | 'read' | 'listings' | 'health' | 'form';

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
  /** The answer comes after `delayMs`; with `afterApply`, the change is made at once. */
  | { type: 'slow'; delayMs: number; afterApply: boolean }
  /** A read serves the listing as it was before its latest change. */
  | { type: 'stale_read' }
  /** The page without the elements the adapter reads, as after a site redesign. */
  | { type: 'redesigned' };

export interface FakeMercariFaultRule {
  action: FakeMercariAction;
  fault: FakeMercariFault;
  /** How many matching requests get it (default 1). */
  times?: number;
}

/** Mercari's states: on sale, deactivated, sold and waiting to ship, sold and done. */
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
  shippingPayer: string;
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
}

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
] as const;

const SIZES: Readonly<Record<Exclude<MercariSizeKind, 'none'>, readonly string[]>> = {
  clothing: [
    'XXS',
    'XS',
    'S',
    'M',
    'L',
    'XL',
    'XXL',
    '3XL',
    '4XL',
    'One size',
    '00',
    '0',
    ...Array.from({ length: 12 }, (_, index) => String((index + 1) * 2)),
    ...Array.from({ length: 17 }, (_, index) => String(28 + index)),
  ],
  shoes: Array.from({ length: 21 }, (_, index) => {
    const size = 5 + index / 2;
    return Number.isInteger(size) ? String(size) : `${String(Math.floor(size))}.5`;
  }),
};

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

export class FakeMercariSite {
  readonly #server: Server;
  readonly #pageSize: number;
  readonly #items = new Map<string, StoredItem>();
  readonly #deleted = new Set<string>();
  readonly #sessions = new Map<string, Session>();
  readonly #faults: (FakeMercariFaultRule & { remaining: number })[] = [];
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly requests: FakeMercariRequest[] = [];
  #nextId = 10_000_000_001;
  #url = '';

  private constructor(options: FakeMercariOptions) {
    this.#pageSize = options.pageSize ?? 10;
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
        size: 'M',
        shippingPayer: 'Buyer',
        shippingWeight: weightLabel('8 oz'),
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

  /** The seller deletes the listing; its page then shows Mercari's "deleted" notice. */
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
      case 'slow':
      case 'stale_read':
      case undefined:
        break;
    }

    const form = route.method === 'POST' ? await readForm(request) : null;
    if (fault?.type === 'reject' && form !== null) {
      return refused(fault.message, route.id === null ? null : this.#items.get(route.id));
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
          body: page(
            'My page | Mercari',
            `<main data-testid="MyPage"><h1>Your account</h1></main>`,
          ),
        };
      case 'form':
        if (route.id === null)
          return { status: 200, body: page('Sell | Mercari', listingForm(null)) };
        return this.#owned(route.id, session, (stored) =>
          stored.current.status === 'on_sale' || stored.current.status === 'inactive'
            ? { status: 200, body: page('Edit listing | Mercari', listingForm(stored.current)) }
            : redirect(`/us/item/${stored.current.id}/`),
        );
      case 'create': {
        const fields = listingFields(form, null);
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
        return redirect(`/us/item/${id}/`);
      }
      case 'update':
        return this.#owned(route.id, session, (stored) => {
          if (stored.current.status !== 'on_sale' && stored.current.status !== 'inactive') {
            return refused('Sold items cannot be edited.', stored);
          }
          const fields = listingFields(form, stored.current);
          if (typeof fields === 'string') return refused(fields, stored);
          this.#change(stored, fields);
          return redirect(`/us/item/${stored.current.id}/`);
        });
      case 'end':
        return this.#owned(route.id, session, (stored) => {
          if (stored.current.status === 'on_sale') this.#change(stored, { status: 'inactive' });
          return redirect(`/us/item/${stored.current.id}/`);
        });
      case 'relist':
        return this.#owned(route.id, session, (stored) => {
          if (stored.current.status === 'inactive') this.#change(stored, { status: 'on_sale' });
          return redirect(`/us/item/${stored.current.id}/`);
        });
      case 'read': {
        const id = route.id ?? '';
        if (this.#deleted.has(id)) {
          return {
            status: 404,
            body: page(
              'Mercari',
              '<p data-testid="ItemDeletedNotice">This item has been deleted.</p>',
            ),
          };
        }
        const stored = this.#items.get(id);
        if (stored === undefined)
          return { status: 404, body: page('Page not found | Mercari', notFound()) };
        const shown =
          fault?.type === 'stale_read' && stored.previous !== null
            ? stored.previous
            : stored.current;
        return { status: 200, body: page(`${shown.title} | Mercari`, itemPage(shown, session)) };
      }
      case 'listings': {
        const tab = route.tab ?? 'active';
        const number = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
        const status = TAB_STATUS[tab];
        const sold = tab === 'in_progress' || tab === 'sold';
        const rows = this.items()
          .filter((item) => item.seller === session.seller && item.status === status)
          .sort((a, b) =>
            sold
              ? (b.soldAt?.getTime() ?? 0) - (a.soldAt?.getTime() ?? 0)
              : b.listedAt.getTime() - a.listedAt.getTime() || b.id.localeCompare(a.id),
          );
        const pageRows = rows.slice((number - 1) * this.#pageSize, number * this.#pageSize);
        const more = rows.length > number * this.#pageSize;
        return {
          status: 200,
          body: page('Listings | Mercari', listingsPage(tab, pageRows, number, more)),
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
  const tab = /^\/mypage\/listings\/(active|inactive|in_progress|sold)\/$/.exec(path)?.[1];
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
  | 'shippingPayer'
  | 'shippingWeight'
  | 'photos'
>;

/** The form's fields, or Mercari's message for the first problem. */
function listingFields(
  form: SubmittedForm | null,
  existing: FakeMercariItem | null,
): ListingFields | string {
  const text = (name: string): string => form?.text(name) ?? '';
  const title = text('name');
  const description = text('description');
  const price = text('price');
  const photos = form?.files('photos') ?? [];
  const category = [text('categoryL0'), text('categoryL1'), text('categoryL2')].filter(
    (name) => name !== '',
  );
  const leaf = mappedMercariCategories().find(
    (entry) => entry.path.join(' > ') === category.join(' > '),
  );
  const brand = text('brand');
  const condition = Number(text('condition'));
  const size = text('size');
  const weight = text('shippingWeight');
  const keptPhotos = photos.length === 0 && existing !== null ? existing.photos : photos;
  if (keptPhotos.length === 0) return 'Add at least 1 photo.';
  if (keptPhotos.length > LIMITS.photos) return 'You can add up to 12 photos.';
  if (title === '') return 'Enter a title.';
  if (title.length > LIMITS.title) return 'Title must be 80 characters or less.';
  if (description === '') return 'Enter a description.';
  if (description.length > LIMITS.description) {
    return 'Description must be 1,000 characters or less.';
  }
  if (leaf === undefined) return 'Select a category.';
  if (brand !== '' && !(FAKE_MERCARI_BRANDS as readonly string[]).includes(brand)) {
    return 'Select a brand from the list.';
  }
  if (!Object.values(MERCARI_CONDITIONS).some((option) => option.id === condition)) {
    return 'Select the condition.';
  }
  if (leaf.size !== 'none' && !SIZES[leaf.size].includes(size)) return 'Select a size.';
  if (!SHIPPING_WEIGHTS.some((option) => weightLabel(option) === weight)) {
    return 'Select a shipping option.';
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
    brand: brand === '' ? null : brand,
    conditionId: condition,
    size: leaf.size === 'none' ? null : size,
    shippingPayer: text('shippingPayer'),
    shippingWeight: weight,
    photos: keptPhotos,
  };
}

// Pages ---------------------------------------------------------------------------------------

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body>${body}</body></html>`;
}

function notFound(): string {
  return '<main data-testid="NotFound"><h1>We couldn’t find that page.</h1></main>';
}

function loginForm(): string {
  return `<main><h1>Log in to Mercari</h1><form method="post" action="/login/"><input name="email" type="email"><input name="password" type="password"><button type="submit">Log in</button></form></main>`;
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

function itemPage(item: FakeMercariItem, session: Session): string {
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
</main>`;
}

function listingsPage(
  tab: MercariListingTab,
  rows: readonly FakeMercariItem[],
  number: number,
  more: boolean,
): string {
  const sold = tab === 'in_progress' || tab === 'sold';
  const items = rows
    .map(
      (item) =>
        `<li data-testid="ListingRow"><a data-testid="ListingLink" href="/us/item/${item.id}/"><span data-testid="ListingName">${escape(item.title)}</span></a><span data-testid="ListingPrice">${dollars(item.priceCents)}</span>${sold ? `<time data-testid="SoldAt" datetime="${(item.soldAt ?? item.updatedAt).toISOString()}">sold</time><span data-testid="BuyerName">a buyer</span>` : ''}</li>`,
    )
    .join('');
  const next = more
    ? `<a data-testid="NextPage" href="/mypage/listings/${tab}/?page=${String(number + 1)}">Next</a>`
    : '';
  return `<main><h1>Listings</h1><ul data-testid="ListingList">${items}</ul>${next}</main>`;
}

/**
 * The listing form, with the small script that makes Mercari's pickers work: each category
 * level's options appear once the level above is picked, the size list follows the category,
 * and the brand search suggests brands from Mercari's list as the seller types.
 */
function listingForm(item: FakeMercariItem | null): string {
  const action = item === null ? '/sell/' : `/sell/edit/${item.id}/`;
  const value = (text: string | null | undefined): string => escape(text ?? '');
  const tree = mappedMercariCategories().map((entry) => ({ path: entry.path, size: entry.size }));
  const conditions = Object.values(MERCARI_CONDITIONS)
    .map(
      (option) =>
        `<label><input type="radio" name="condition" value="${String(option.id)}"${item?.conditionId === option.id ? ' checked' : ''}> ${option.label}</label>`,
    )
    .join('');
  const weights = SHIPPING_WEIGHTS.map((weight) => {
    const label = weightLabel(weight);
    return `<option value="${label}"${item?.shippingWeight === label ? ' selected' : ''}>${label}</option>`;
  }).join('');
  const buttons =
    item === null
      ? '<button type="submit" data-testid="ListButton">List</button>'
      : `<button type="submit" data-testid="SaveButton">Save changes</button>`;
  const status =
    item === null
      ? ''
      : item.status === 'on_sale'
        ? confirmation('Deactivate', 'DeactivateButton', `/sell/edit/${item.id}/deactivate`)
        : confirmation('Activate', 'ActivateButton', `/sell/edit/${item.id}/activate`);
  const current = {
    category: item?.category ?? [],
    size: item?.size ?? null,
  };
  return `<form method="post" action="${action}" enctype="multipart/form-data" data-testid="ListingForm">
<label>Photos <input type="file" name="photos" data-testid="PhotoInput" multiple accept="image/jpeg"></label>
<label>Title <input name="name" data-testid="Title" value="${value(item?.title)}"></label>
<label>Description <textarea name="description" data-testid="Description">${value(item?.description)}</textarea></label>
<select name="categoryL0" data-testid="CategoryL0"><option value="">Category</option></select>
<select name="categoryL1" data-testid="CategoryL1"><option value="">Subcategory</option></select>
<select name="categoryL2" data-testid="CategoryL2"><option value="">Type</option></select>
<label>Brand <input name="brand" data-testid="Brand" autocomplete="off" value="${value(item?.brand)}"></label>
<ul data-testid="BrandSuggestions" hidden></ul>
<fieldset>${conditions}</fieldset>
<select name="size" data-testid="Size"><option value="">Size</option></select>
<select name="shippingPayer" data-testid="ShippingPayer"><option value="">Who pays</option><option value="Buyer"${item?.shippingPayer === 'Buyer' ? ' selected' : ''}>Buyer</option><option value="Seller"${item?.shippingPayer === 'Seller' ? ' selected' : ''}>Seller</option></select>
<select name="shippingWeight" data-testid="ShippingWeight"><option value="">Package weight</option>${weights}</select>
<label>Price $<input name="price" data-testid="Price" inputmode="numeric" value="${item === null ? '' : String(item.priceCents / 100)}"></label>
${buttons}
</form>
${status}
<script>
(() => {
  const tree = ${scriptJson(tree)};
  const sizes = ${scriptJson(SIZES)};
  const brands = ${scriptJson(FAKE_MERCARI_BRANDS)};
  const current = ${scriptJson(current)};
  const levels = [0, 1, 2].map((level) => document.querySelector('[data-testid="CategoryL' + level + '"]'));
  const size = document.querySelector('[data-testid="Size"]');
  const fill = (select, names, placeholder) => {
    select.replaceChildren(new Option(placeholder, ''), ...names.map((name) => new Option(name, name)));
  };
  const picked = (upTo) => levels.slice(0, upTo).map((select) => select.value);
  const children = (path) => [...new Set(tree
    .filter((entry) => entry.path.length > path.length && path.every((name, index) => entry.path[index] === name))
    .map((entry) => entry.path[path.length]))];
  const leaf = () => tree.find((entry) => entry.path.join('>') === picked(3).filter(Boolean).join('>'));
  const refresh = (from) => {
    for (let level = from + 1; level < 3; level += 1) {
      fill(levels[level], picked(level).every(Boolean) ? children(picked(level)) : [], level === 1 ? 'Subcategory' : 'Type');
    }
    const entry = leaf();
    fill(size, entry && entry.size !== 'none' ? sizes[entry.size] : [], 'Size');
  };
  fill(levels[0], children([]), 'Category');
  levels.forEach((select, level) => select.addEventListener('change', () => refresh(level)));
  current.category.forEach((name, level) => { levels[level].value = name; refresh(level); });
  if (current.size) size.value = current.size;
  const brand = document.querySelector('[data-testid="Brand"]');
  const list = document.querySelector('[data-testid="BrandSuggestions"]');
  brand.addEventListener('input', () => {
    const typed = brand.value.trim().toLowerCase();
    const found = typed === '' ? [] : brands.filter((name) => name.toLowerCase().includes(typed));
    list.replaceChildren(...(found.length === 0
      ? [Object.assign(document.createElement('li'), { textContent: 'No brands found' })]
      : found.map((name) => {
          const option = Object.assign(document.createElement('li'), { textContent: name });
          option.dataset.testid = 'BrandSuggestion';
          option.addEventListener('click', () => { brand.value = name; list.hidden = true; });
          return option;
        })));
    list.hidden = typed === '';
  });
  document.querySelectorAll('[data-confirm]').forEach((button) => {
    button.addEventListener('click', () => {
      document.getElementById(button.dataset.confirm).hidden = false;
    });
  });
})();
</script>`;
}

/** A Deactivate or Activate button and the dialog that confirms it. */
function confirmation(label: string, testId: string, action: string): string {
  const dialog = `confirm-${testId}`;
  return `<button type="button" data-testid="${testId}" data-confirm="${dialog}">${label}</button>
<div role="dialog" data-testid="ConfirmModal" id="${dialog}" hidden><p>${label} this listing?</p><form method="post" action="${action}"><button type="submit" data-testid="ConfirmButton">${label}</button></form></div>`;
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
