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
 *   GET  /media/<name>.jpg            a listing photo on the fake's image CDN (fake-photos.ts)
 *
 * Every page except the sign-in pages needs the session cookie; without a valid one it
 * redirects to the sign-in chooser, as Vinted does.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SessionCookie } from '@listora/connections';

import { FAKE_MEDIA_PATH, fakeMediaPhoto } from '../../fake-photos/fake-photos.ts';
import { VINTED_LOGIN_PATH, VINTED_PATHS } from '../site.ts';

/** Vinted's session cookie, as the fake names it. */
const SESSION_COOKIE = '_vinted_fr_session';

/** What a fault is injected into: the session check, the wardrobe and item reads, or the orders. */
export type FakeVintedAction = 'health' | 'listings' | 'orders';

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
  | { type: 'server_error' }
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
}

/** One sold order, as the fake keeps it. */
export interface FakeVintedOrder {
  id: string;
  /** When the buyer paid. */
  paidAt: Date;
  state: 'in_progress' | 'completed' | 'canceled';
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
  /** The next answer for the member signed in shows no login (the `no_login` fault). */
  #hideLogin = false;

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
      const found = this.items.find((one) => one.id === item[1]);
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
        status: order.state === 'completed' ? 'Order completed' : 'Payment successful',
      })),
      pagination,
    });
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
          headers: { 'retry-after': String(fault.retryAfterSeconds ?? 30) },
          body: page('Too many requests | Vinted', '<h1>Too many requests</h1>'),
        };
      case 'server_error':
        return { status: 500, body: page('Error | Vinted', '<h1>Something went wrong</h1>') };
      case 'captcha':
      case 'redesigned':
      case 'no_login':
      case 'datadome_api':
      case 'unknown_shape':
      case 'verification_required':
        return null;
    }
  }
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

function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
