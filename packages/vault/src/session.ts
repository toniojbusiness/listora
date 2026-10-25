/**
 * A seller's marketplace browser session, as the session vault stores it: the cookies the
 * marketplace set when the seller logged in from the iPhone app, and nothing else. Listora never
 * sees or stores the password; when the marketplace stops accepting these cookies the seller
 * logs in again (relinks). The cookie shape is the browser's own (Playwright's `Cookie`), so the
 * runner loads it as it is.
 */
import { z } from 'zod';

/** Browsers cap a cookie's name plus value at 4096 bytes. */
const MAX_COOKIE_BYTES = 4096;
/** A marketplace sets a few dozen cookies; more than this is not a session. */
export const MAX_SESSION_COOKIES = 200;

export const sessionCookieSchema = z
  .object({
    name: z.string().min(1).max(MAX_COOKIE_BYTES),
    value: z.string().max(MAX_COOKIE_BYTES),
    /** A host (`www.poshmark.com`) or a domain cookie (`.poshmark.com`). */
    domain: z
      .string()
      .min(1)
      .max(253)
      .regex(/^\.?[a-z0-9.-]+$/i),
    path: z.string().min(1).max(1024).startsWith('/'),
    /** Unix time in seconds; -1 for a cookie that lasts as long as the browser session. */
    expires: z.number().refine((value) => value === -1 || (Number.isFinite(value) && value > 0)),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(['Strict', 'Lax', 'None']),
  })
  .strict()
  .refine((cookie) => cookie.name.length + cookie.value.length <= MAX_COOKIE_BYTES, {
    message: 'cookie is too large',
  });

export type SessionCookie = z.infer<typeof sessionCookieSchema>;

export const storedSessionSchema = z
  .object({
    cookies: z.array(sessionCookieSchema).min(1).max(MAX_SESSION_COOKIES),
  })
  .strict();

export type StoredSession = z.infer<typeof storedSessionSchema>;

/**
 * Whether a cookie belongs to one of the marketplace's own domains (`poshmark.com` covers
 * `.poshmark.com` and `www.poshmark.com`). The vault keeps no other site's cookies, and the
 * runner loads none.
 */
export function cookieOnDomains(
  cookie: Pick<SessionCookie, 'domain'>,
  domains: readonly string[],
): boolean {
  const host = cookie.domain.replace(/^\./, '').toLowerCase();
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** The cookies still alive at `now` (seconds); session cookies (-1) always are. */
export function liveCookies(
  cookies: readonly SessionCookie[],
  nowSeconds: number,
): SessionCookie[] {
  return cookies.filter((cookie) => cookie.expires === -1 || cookie.expires > nowSeconds);
}

/**
 * Whether two sessions hold the same cookies (name, domain, and path identify one), so an
 * unchanged session is not written again.
 */
export function sameCookies(a: readonly SessionCookie[], b: readonly SessionCookie[]): boolean {
  if (a.length !== b.length) return false;
  const key = (cookie: SessionCookie): string => `${cookie.domain}\n${cookie.path}\n${cookie.name}`;
  const byKey = new Map(a.map((cookie) => [key(cookie), cookie]));
  return b.every((cookie) => {
    const other = byKey.get(key(cookie));
    return (
      other?.value === cookie.value &&
      other.expires === cookie.expires &&
      other.httpOnly === cookie.httpOnly &&
      other.secure === cookie.secure &&
      other.sameSite === cookie.sameSite
    );
  });
}
