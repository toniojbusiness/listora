/**
 * The fake marketplace site: a small HTML web app that behaves like a marketplace a seller uses
 * in a browser, for the browser runner's development and tests. No test ever sends traffic to a
 * real marketplace. It has the pages automation works with (account, listing search, new
 * listing, listing, edit, delete, relist, sold orders, login), session cookies that it rotates,
 * and fault injection for every page automation must stop at or recover from.
 *
 *   GET  /login                 the login page (a password field: no Listora session needs it)
 *   POST /login                 log in by hand: any username and password; sets the session cookie
 *   GET  /                      the seller's account page ([data-account])
 *   GET  /listings?sku=...      search by the seller's SKU
 *   GET  /listings/new          the new-listing form (multipart, with photo upload)
 *   POST /listings              publish
 *   GET  /listings/:id          a listing ([data-listing-id], [data-status], [data-revision])
 *   GET  /listings/:id/edit     the edit form; POST /listings/:id saves it
 *   POST /listings/:id/delete   delete (the page asks to confirm in a dialog)
 *   POST /listings/:id/relist   relist an ended listing
 *   GET  /sold                  sold orders ([data-order-id], [data-sold-at], ...)
 *   GET  /photos/<name>.jpg     a photo, standing in for Listora's image CDN (no session)
 *
 * Every page except /login needs the session cookie; without a valid one it redirects to the
 * login page. Listings carry a revision (the "last updated" marker a page can show) that grows
 * with every change; a stale read serves the listing as it was before its latest change. A
 * removed listing answers 410 with a "removed" notice; an unknown one 404.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SessionCookie } from '@listora/vault';

export type FakeSiteAction =
  'create' | 'update' | 'end' | 'relist' | 'read' | 'search' | 'health' | 'orders' | 'form';

export type FakeSiteFault =
  /** A visible CAPTCHA widget instead of the page. */
  | { type: 'captcha' }
  /** A bot-check interstitial ("Just a moment..."), status 403. */
  | { type: 'bot_check' }
  /** A redirect to a verification-code step. */
  | { type: 'login_challenge' }
  /** The session is invalidated, and the page redirects to the login page. */
  | { type: 'session_expired' }
  | { type: 'rate_limited'; retryAfterSeconds?: number }
  /** A 500 page; with `afterApply`, the change was made first. */
  | { type: 'server_error'; afterApply?: boolean }
  /** A form submission comes back with a validation error; nothing is applied. */
  | { type: 'reject'; message: string }
  /** The answer comes after `delayMs`; with `afterApply`, the change is made at once. */
  | { type: 'slow'; delayMs: number; afterApply: boolean }
  /** A read serves the listing as it was before its latest change. */
  | { type: 'stale_read' }
  /** A redirect to another origin (the same server under `localhost`). */
  | { type: 'offsite' };

export interface FakeSiteFaultRule {
  action: FakeSiteAction;
  fault: FakeSiteFault;
  /** How many matching requests get it (default 1). */
  times?: number;
}

export interface FakeSiteListing {
  id: string;
  /** The seller whose session published it; search and sold orders show only their own. */
  seller: string;
  sku: string;
  status: 'active' | 'ended' | 'sold';
  title: string;
  description: string;
  priceCents: number;
  photoCount: number;
  revision: number;
}

export interface FakeSiteOrder {
  id: string;
  seller: string;
  listingId: string;
  soldAt: Date;
  priceCents: number;
}

export interface FakeSiteRequest {
  method: string;
  path: string;
  action: FakeSiteAction | null;
  userAgent: string;
  at: number;
  fault: FakeSiteFault['type'] | null;
  status: number;
}

export interface FakeSiteOptions {
  /** Rotate the session cookie every this many requests of a session (default: never). */
  rotateSessionEvery?: number;
  /** A relist gives the listing a new id, like a marketplace that reposts (default false). */
  relistIssuesNewId?: boolean;
}

interface StoredListing {
  current: FakeSiteListing;
  previous: FakeSiteListing | null;
}

interface Session {
  seller: string;
  requests: number;
}

const SESSION_COOKIE = 'fake_sid';
/** The start and end markers of a JPEG: what `/photos/*.jpg` serves. */
const PHOTO_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const TITLE_MAX_LENGTH = 80;

export class FakeAutomationSite {
  readonly #server: Server;
  readonly #options: FakeSiteOptions;
  readonly #listings = new Map<string, StoredListing>();
  readonly #removed = new Set<string>();
  readonly #orders: FakeSiteOrder[] = [];
  readonly #sessions = new Map<string, Session>();
  readonly #faults: (FakeSiteFaultRule & { remaining: number })[] = [];
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly requests: FakeSiteRequest[] = [];
  #nextId = 1;
  #url = '';

  private constructor(options: FakeSiteOptions) {
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

  static async start(port = 0, options: FakeSiteOptions = {}): Promise<FakeAutomationSite> {
    const site = new FakeAutomationSite(options);
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

  /** Whether a session cookie value still logs in. */
  sessionValid(token: string): boolean {
    return this.#sessions.has(token);
  }

  inject(rule: FakeSiteFaultRule): void {
    this.#faults.push({ ...rule, remaining: rule.times ?? 1 });
  }

  clearFaults(): void {
    this.#faults.length = 0;
  }

  /** The listings with this SKU. */
  listings(sku?: string): FakeSiteListing[] {
    return [...this.#listings.values()]
      .map((stored) => ({ ...stored.current }))
      .filter((listing) => sku === undefined || listing.sku === sku);
  }

  listing(id: string): FakeSiteListing | undefined {
    const stored = this.#listings.get(id);
    return stored === undefined ? undefined : { ...stored.current };
  }

  /** Publishes a listing directly, as the seller once did by hand; returns its id. */
  seed(
    listing: Pick<FakeSiteListing, 'sku' | 'title' | 'description' | 'priceCents'> & {
      seller?: string;
    },
  ): string {
    const id = `L${String(this.#nextId++)}`;
    this.#listings.set(id, {
      current: {
        id,
        seller: listing.seller ?? 'fake-seller',
        sku: listing.sku,
        status: 'active',
        title: listing.title,
        description: listing.description,
        priceCents: listing.priceCents,
        photoCount: 1,
        revision: 1,
      },
      previous: null,
    });
    return id;
  }

  /** Drops a listing, which then answers 410 Gone. */
  remove(id: string): void {
    this.#listings.delete(id);
    this.#removed.add(id);
  }

  /** A buyer buys the listing: it is sold, and the order shows on the sold page. */
  sell(listingId: string, soldAt = new Date()): FakeSiteOrder {
    const stored = this.#listings.get(listingId);
    if (stored === undefined) throw new Error(`no listing ${listingId}`);
    this.#change(stored, { status: 'sold' });
    const order = {
      id: `O${String(this.#nextId++)}`,
      seller: stored.current.seller,
      listingId,
      soldAt,
      priceCents: stored.current.priceCents,
    };
    this.#orders.push(order);
    return order;
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
    const record: FakeSiteRequest = {
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
        // The seller logs in by hand, as on the app's linking screen in development: any
        // username with a password starts a session as that seller.
        const form = await readForm(request);
        const seller = form.text('username');
        if (seller !== '' && form.text('password') !== '') {
          const { value } = this.issueSession(seller);
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
      send({ status: 200, body: page('Log in', loginForm()) });
      return;
    }
    if (url.pathname === '/verify') {
      send({ status: 200, body: page('Verify it is you', verifyForm()) });
      return;
    }
    if (/^\/photos\/[\w.-]+\.jpg$/.test(url.pathname)) {
      // A stand-in for Listora's own image CDN, which listing photos are fetched from.
      record.status = 200;
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      response.end(PHOTO_BYTES);
      return;
    }
    if (url.pathname === '/elsewhere') {
      send({ status: 200, body: page('Elsewhere', '<p>Not the marketplace.</p>') });
      return;
    }

    const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
    const session = token === undefined ? undefined : this.#sessions.get(token);
    const route = matchRoute(method, url.pathname);
    record.action = route?.action ?? null;
    if (session === undefined || token === undefined) {
      send(redirect('/login'));
      return;
    }

    const headers: Record<string, string> = {};
    session.requests += 1;
    const every = this.#options.rotateSessionEvery;
    if (every !== undefined && session.requests % every === 0) {
      // A refreshed session cookie; the old one stops working at once.
      const next = randomBytes(16).toString('hex');
      this.#sessions.delete(token);
      this.#sessions.set(next, { ...session });
      headers['set-cookie'] =
        `${SESSION_COOKIE}=${next}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
    }

    if (route === null) {
      send({
        status: 404,
        headers,
        body: page('Not found', '<p data-not-found>No such page.</p>'),
      });
      return;
    }
    const fault = this.#takeFault(route.action);
    record.fault = fault?.type ?? null;
    const reply = await this.#route(route, url, request, session, token, fault);
    send({ ...reply, headers: { ...headers, ...reply.headers } });
  }

  async #route(
    route: Route,
    url: URL,
    request: IncomingMessage,
    session: Session,
    token: string,
    fault: FakeSiteFault | undefined,
  ): Promise<Reply> {
    switch (fault?.type) {
      case 'captcha':
        return { status: 200, body: page('Security verification', captchaWidget()) };
      case 'bot_check':
        return { status: 403, body: page('Just a moment...', '<p>Checking your browser.</p>') };
      case 'login_challenge':
        return redirect('/verify');
      case 'session_expired':
        this.#sessions.delete(token);
        return redirect('/login');
      case 'rate_limited':
        return {
          status: 429,
          headers:
            fault.retryAfterSeconds === undefined
              ? {}
              : { 'retry-after': String(fault.retryAfterSeconds) },
          body: page('Slow down', '<p>Too many requests.</p>'),
        };
      case 'offsite':
        return redirect(`${this.#url.replace('127.0.0.1', 'localhost')}/elsewhere`);
      case 'server_error':
      case 'reject':
      case 'slow':
      case 'stale_read':
      case undefined:
        break;
    }

    const form = route.method === 'POST' ? await readForm(request) : null;
    if (fault?.type === 'reject' && form !== null) {
      return {
        status: 422,
        body: page('Fix the listing', `<p data-error>${escape(fault.message)}</p>`),
      };
    }
    const apply = (): Reply => this.#apply(route, url, form, session, fault);
    if (fault?.type === 'server_error') {
      if (fault.afterApply === true) apply();
      return { status: 500, body: page('Something went wrong', '<p>Server error.</p>') };
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
    return apply();
  }

  #apply(
    route: Route,
    url: URL,
    form: SubmittedForm | null,
    session: Session,
    fault: FakeSiteFault | undefined,
  ): Reply {
    switch (route.action) {
      case 'health':
        return {
          status: 200,
          body: page(
            'Your account',
            `<main data-account="${escape(session.seller)}"><h1>Hi</h1></main>`,
          ),
        };
      case 'search': {
        const sku = url.searchParams.get('sku') ?? '';
        const found =
          sku === ''
            ? []
            : this.listings(sku).filter((listing) => listing.seller === session.seller);
        const items = found
          .map(
            (listing) =>
              `<li><a data-listing-id="${listing.id}" href="/listings/${listing.id}">${escape(listing.title)}</a></li>`,
          )
          .join('');
        return {
          status: 200,
          body: page(
            'Your listings',
            found.length === 0 ? '<p data-empty>No listings.</p>' : `<ul>${items}</ul>`,
          ),
        };
      }
      case 'form':
        if (route.id === null) return { status: 200, body: page('New listing', listingForm(null)) };
        return this.#withListing(route.id, (stored) => ({
          status: 200,
          body: page('Edit listing', listingForm(stored.current)),
        }));
      case 'create': {
        const fields = listingFields(form);
        const problem = invalidListing(fields);
        if (problem !== null) {
          return {
            status: 422,
            body: page(
              'Fix the listing',
              `<p data-error>${escape(problem)}</p>${listingForm(null)}`,
            ),
          };
        }
        const id = `L${String(this.#nextId++)}`;
        this.#listings.set(id, {
          current: { id, seller: session.seller, status: 'active', revision: 1, ...fields },
          previous: null,
        });
        return redirect(`/listings/${id}`);
      }
      case 'update':
        return this.#withListing(route.id, (stored) => {
          const fields = listingFields(form);
          const problem = invalidListing({ ...fields, photoCount: stored.current.photoCount });
          if (problem !== null) {
            return {
              status: 422,
              body: page('Fix the listing', `<p data-error>${escape(problem)}</p>`),
            };
          }
          this.#change(stored, {
            title: fields.title,
            description: fields.description,
            priceCents: fields.priceCents,
          });
          return redirect(`/listings/${stored.current.id}`);
        });
      case 'end':
        return this.#withListing(route.id, (stored) => {
          if (stored.current.status === 'active') this.#change(stored, { status: 'ended' });
          return redirect(`/listings/${stored.current.id}`);
        });
      case 'relist':
        return this.#withListing(route.id, (stored) => {
          if (stored.current.status !== 'ended') {
            return {
              status: 409,
              body: page('Not ended', '<p data-error>Only ended listings relist.</p>'),
            };
          }
          if (this.#options.relistIssuesNewId === true) {
            const id = `L${String(this.#nextId++)}`;
            this.#listings.set(id, {
              current: { ...stored.current, id, status: 'active', revision: 1 },
              previous: null,
            });
            return redirect(`/listings/${id}`);
          }
          this.#change(stored, { status: 'active' });
          return redirect(`/listings/${stored.current.id}`);
        });
      case 'read':
        return this.#withListing(route.id, (stored) => {
          const shown =
            fault?.type === 'stale_read' && stored.previous !== null
              ? stored.previous
              : stored.current;
          return { status: 200, body: page(shown.title, listingPage(shown)) };
        });
      case 'orders': {
        const items = this.#orders
          .filter((order) => order.seller === session.seller)
          .map(
            (order) =>
              `<li data-order-id="${order.id}" data-sold-at="${order.soldAt.toISOString()}" data-listing-id="${order.listingId}" data-price-cents="${String(order.priceCents)}">Order ${order.id}</li>`,
          )
          .join('');
        return { status: 200, body: page('Sold', `<ul data-orders>${items}</ul>`) };
      }
    }
  }

  #withListing(id: string | null, act: (stored: StoredListing) => Reply): Reply {
    if (id !== null && this.#removed.has(id)) {
      return {
        status: 410,
        body: page('Removed', '<p data-removed>This listing was removed.</p>'),
      };
    }
    const stored = id === null ? undefined : this.#listings.get(id);
    if (stored === undefined) {
      return { status: 404, body: page('Not found', '<p data-not-found>No such listing.</p>') };
    }
    return act(stored);
  }

  #change(stored: StoredListing, change: Partial<FakeSiteListing>): void {
    stored.previous = { ...stored.current };
    stored.current = { ...stored.current, ...change, revision: stored.current.revision + 1 };
  }

  #takeFault(action: FakeSiteAction): FakeSiteFault | undefined {
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
  action: FakeSiteAction;
  id: string | null;
}

function matchRoute(method: string, path: string): Route | null {
  if (method === 'GET' && path === '/') return { method, action: 'health', id: null };
  if (method === 'GET' && path === '/listings') return { method, action: 'search', id: null };
  if (method === 'GET' && path === '/listings/new') return { method, action: 'form', id: null };
  if (method === 'POST' && path === '/listings') return { method, action: 'create', id: null };
  if (method === 'GET' && path === '/sold') return { method, action: 'orders', id: null };
  const match = /^\/listings\/([A-Za-z0-9-]+)(\/(edit|delete|relist))?$/.exec(path);
  if (match === null) return null;
  const id = match[1] ?? null;
  const sub = match[3];
  if (method === 'GET' && sub === undefined) return { method, action: 'read', id };
  if (method === 'GET' && sub === 'edit') return { method, action: 'form', id };
  if (method === 'POST' && sub === undefined) return { method, action: 'update', id };
  if (method === 'POST' && sub === 'delete') return { method, action: 'end', id };
  if (method === 'POST' && sub === 'relist') return { method, action: 'relist', id };
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

/** A submitted form: its text fields, and how many bytes each file field brought. */
interface SubmittedForm {
  text(name: string): string;
  /** The sizes of the non-empty files sent in `name`. */
  files(name: string): number[];
}

async function readForm(request: IncomingMessage): Promise<SubmittedForm> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const type = request.headers['content-type'] ?? '';
  const boundary = /^multipart\/form-data;.*boundary=("?)([^";]+)\1/i.exec(type)?.[2];
  const fields = new Map<string, string>();
  const files = new Map<string, number[]>();
  if (boundary === undefined) {
    for (const [name, value] of new URLSearchParams(body.toString('utf8'))) fields.set(name, value);
  } else {
    // The parts between the boundary lines: headers, a blank line, then the content.
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
        if (name !== undefined) {
          if (headers.includes('filename="')) {
            if (content.length > 0) files.set(name, [...(files.get(name) ?? []), content.length]);
          } else {
            fields.set(name, content.toString('utf8'));
          }
        }
      }
      start = next;
    }
  }
  return {
    text: (name) => fields.get(name)?.trim() ?? '',
    files: (name) => files.get(name) ?? [],
  };
}

function listingFields(form: SubmittedForm | null): ListingFields {
  const text = (name: string): string => form?.text(name) ?? '';
  const dollars = Number(text('price'));
  return {
    sku: text('sku'),
    title: text('title'),
    description: text('description'),
    priceCents: Number.isFinite(dollars) ? Math.round(dollars * 100) : 0,
    photoCount: form?.files('photos').length ?? 0,
  };
}

type ListingFields = Omit<FakeSiteListing, 'id' | 'seller' | 'status' | 'revision'>;

function invalidListing(fields: ListingFields): string | null {
  if (fields.title === '') return 'Add a title.';
  if (fields.title.length > TITLE_MAX_LENGTH) return 'Titles can be at most 80 characters.';
  if (fields.priceCents <= 0) return 'Add a price above $0.';
  if (fields.photoCount === 0) return 'Add at least one photo.';
  return null;
}

// Pages ---------------------------------------------------------------------------------------

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body>${body}</body></html>`;
}

function loginForm(): string {
  return `<form method="post" action="/login"><label>Username <input name="username" id="username"></label><label>Password <input type="password" name="password" id="password"></label><button type="submit">Log in</button></form>`;
}

function verifyForm(): string {
  return `<form method="post" action="/verify"><p>Enter the code we sent to your email.</p><input name="code" id="code"><button type="submit">Verify</button></form>`;
}

function captchaWidget(): string {
  return `<p>Please complete the security check.</p><div class="g-recaptcha" data-sitekey="fake-site-key" style="width:304px;height:78px;border:1px solid #ccc"></div>`;
}

function listingForm(listing: FakeSiteListing | null): string {
  const action = listing === null ? '/listings' : `/listings/${listing.id}`;
  const value = (text: string | undefined): string => (text === undefined ? '' : escape(text));
  const price = listing === null ? '' : (listing.priceCents / 100).toFixed(2);
  return `<form method="post" action="${action}" enctype="multipart/form-data">
<label>Title <input id="title" name="title" value="${value(listing?.title)}"></label>
<label>Description <textarea id="description" name="description">${value(listing?.description)}</textarea></label>
<label>Price <input id="price" name="price" value="${price}"></label>
${listing === null ? '<label>SKU <input id="sku" name="sku"></label><label>Photos <input id="photos" name="photos" type="file" multiple accept="image/jpeg"></label>' : ''}
<button id="save" type="submit">${listing === null ? 'Publish' : 'Save'}</button>
</form>`;
}

function listingPage(listing: FakeSiteListing): string {
  const actions =
    listing.status === 'active'
      ? `<a id="edit" href="/listings/${listing.id}/edit">Edit</a><form method="post" action="/listings/${listing.id}/delete" onsubmit="return confirm('Delete this listing?')"><button id="delete" type="submit">Delete</button></form>`
      : listing.status === 'ended'
        ? `<form method="post" action="/listings/${listing.id}/relist"><button id="relist" type="submit">Relist</button></form>`
        : '';
  return `<article data-listing-id="${listing.id}" data-sku="${escape(listing.sku)}" data-status="${listing.status}" data-revision="${String(listing.revision)}">
<h1 data-field="title">${escape(listing.title)}</h1>
<p data-field="description">${escape(listing.description)}</p>
<span data-field="price" data-cents="${String(listing.priceCents)}">$${(listing.priceCents / 100).toFixed(2)}</span>
<span data-field="photos" data-count="${String(listing.photoCount)}"></span>
${actions}
</article>`;
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
