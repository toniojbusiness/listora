/**
 * The fake Vinted site: a local web app with the pages of Vinted's US site that the Vinted
 * automation adapter uses (docs/features/vinted.md), for its development and tests. No test
 * sends traffic to Vinted. It mirrors Vinted's pages as the adapter's page modules model them
 * (`pages/`): the same paths and selectors, invented, until the read-only mapping of Vinted's
 * pages (Vinted plan M2) records the real ones. Milestone M3 needs only signing in and the
 * session check, so it serves only those, with Vinted's checks as fault injection.
 *
 *   GET  /member/signup/select_type   the sign-up and sign-in chooser (a password field: no session needs it)
 *   POST /member/signup/select_type   sign in by hand: any login and password; sets the session cookie
 *   GET  /member/verification         a sign-in code step
 *   GET  /settings/profile            the member's profile settings, with the header's own-profile link
 *   GET  /                            the home page, with the same header
 *
 * Every page except the sign-in pages needs the session cookie; without a valid one it
 * redirects to the sign-in chooser, as Vinted does.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SessionCookie } from '@listora/connections';

import { VINTED_LOGIN_PATH, VINTED_PATHS } from '../site.ts';

/** Vinted's session cookie, as the fake names it. */
const SESSION_COOKIE = '_vinted_fr_session';

export type FakeVintedAction = 'health';

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
  /** The page without the header's own-profile link, as after a site redesign. */
  | { type: 'redesigned' }
  /** The own-profile link with only the member's id, no login after it. */
  | { type: 'no_login' };

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

    if (url.pathname === VINTED_PATHS.account || url.pathname === '/') {
      const fault = url.pathname === VINTED_PATHS.account ? this.#takeFault() : null;
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
          `${header(member, fault?.type === 'redesigned' ? 'none' : fault?.type === 'no_login' ? 'id' : 'login')}<main><h1>Profile details</h1><form><label>About you <textarea name="about"></textarea></label></form></main>${fault?.type === 'captcha' ? '<div class="g-recaptcha" data-sitekey="fake" style="width:300px;height:80px"></div>' : ''}`,
        ),
      });
      return;
    }
    send({ status: 404, body: page('Page not found | Vinted', '<h1>Page not found</h1>') });
  }

  /** The next fault, used up once its `times` are (the session check is the only action yet). */
  #takeFault(): FakeVintedFault | null {
    const entry = this.#faults[0];
    if (entry === undefined) return null;
    entry.left -= 1;
    if (entry.left <= 0) this.#faults.shift();
    return entry.rule.fault;
  }

  /** The reply a fault stands for, or `null` for a fault drawn in the page itself. */
  #faultReply(fault: FakeVintedFault, token: string, path: string, member: Member): Reply | null {
    switch (fault.type) {
      case 'datadome':
        return {
          status: 403,
          body: page(
            'vinted.com',
            `${header(member, 'login')}<div id="ddChallengeContainer"><p>Please complete the check.</p></div>`,
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
        return null;
    }
  }
}

function redirectToLogin(path: string): Reply {
  return {
    status: 302,
    headers: { location: `${VINTED_LOGIN_PATH}?ref_url=${encodeURIComponent(path)}` },
  };
}

/** The page header: the user menu with the member's own profile link (or none, or its id only). */
function header(member: Member, link: 'login' | 'id' | 'none'): string {
  const href =
    link === 'login'
      ? `/member/${member.id}-${encodeURIComponent(member.login)}`
      : `/member/${member.id}`;
  const menu =
    link === 'none'
      ? '<nav data-testid="account-nav"><span>Menu</span></nav>'
      : `<div data-testid="user-menu"><a href="${href}">Profile</a><a href="/settings/profile">Settings</a></div>`;
  return `<header><a href="/">Vinted</a>${menu}</header>`;
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
