import { describe, expect, it } from 'vitest';

import {
  cookieOnDomains,
  liveCookies,
  sameCookies,
  sessionCookieSchema,
  type SessionCookie,
} from './session.ts';

function cookie(overrides: Partial<SessionCookie> = {}): SessionCookie {
  return {
    name: 'sid',
    value: 'abc',
    domain: '.poshmark.com',
    path: '/',
    expires: 2_000_000_000,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...overrides,
  };
}

describe('session cookies', () => {
  it('accepts browser cookies and refuses anything else', () => {
    expect(sessionCookieSchema.safeParse(cookie()).success).toBe(true);
    expect(sessionCookieSchema.safeParse(cookie({ expires: -1 })).success).toBe(true);
    for (const bad of [
      { ...cookie(), password: 'hunter2' },
      cookie({ name: '' }),
      cookie({ domain: 'poshmark.com/evil' }),
      cookie({ path: 'relative' }),
      cookie({ expires: 0 }),
      cookie({ value: 'x'.repeat(4096) }),
    ]) {
      expect(sessionCookieSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(
        false,
      );
    }
  });

  it("matches only the marketplace's own domains and their subdomains", () => {
    const domains = ['poshmark.com'];
    expect(cookieOnDomains(cookie({ domain: '.poshmark.com' }), domains)).toBe(true);
    expect(cookieOnDomains(cookie({ domain: 'www.poshmark.com' }), domains)).toBe(true);
    expect(cookieOnDomains(cookie({ domain: 'POSHMARK.COM' }), domains)).toBe(true);
    expect(cookieOnDomains(cookie({ domain: 'notposhmark.com' }), domains)).toBe(false);
    expect(cookieOnDomains(cookie({ domain: 'poshmark.com.evil.test' }), domains)).toBe(false);
  });

  it('drops expired cookies and keeps session cookies', () => {
    const cookies = [cookie({ name: 'old', expires: 100 }), cookie({ expires: -1 }), cookie()];
    expect(liveCookies(cookies, 1_000).map((c) => c.name)).toEqual(['sid', 'sid']);
  });

  it('tells a refreshed session from an unchanged one', () => {
    const session = [cookie(), cookie({ name: 'csrf', value: 'x' })];
    expect(sameCookies(session, [...session].reverse())).toBe(true);
    expect(sameCookies(session, [cookie({ value: 'rotated' }), session[1] ?? cookie()])).toBe(
      false,
    );
    expect(sameCookies(session, [cookie()])).toBe(false);
    expect(sameCookies(session, [cookie({ expires: 2_100_000_000 }), session[1] ?? cookie()])).toBe(
      false,
    );
  });
});
