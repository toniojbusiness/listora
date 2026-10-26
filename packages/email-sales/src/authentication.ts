/**
 * Whether a forwarded email really comes from who it says (plan red flag RF8: a spoofed "sold"
 * email must never delist anything). Listora acts on an email only when both hold:
 *
 * - **SPF passed** for the server that handed Listora the mail (the seller's email provider,
 *   which rewrites the envelope sender when it forwards), so the last hop was not forged; and
 * - **DKIM passed** for a signature of the sender's own domain, aligned with the From address
 *   (`orders@poshmark.com` signed by `poshmark.com` or one of its subdomains). Automatic
 *   forwarding keeps the marketplace's signature intact; a look-alike domain or a message
 *   signed only by the forwarder or an attacker's domain fails.
 *
 * The verdicts come from the receiving server: in AWS, SES's receipt verdicts and the
 * `Authentication-Results` header SES adds on top of the stored message; in development, the
 * first `Authentication-Results` header of the dropped file. Only the first header counts, and
 * only from the trusted receiver, because a sender can put any header lower in its message.
 */
import { headerValues, type MailMessage } from './message.ts';

export const AUTH_VERDICTS = [
  'pass',
  'fail',
  'softfail',
  'neutral',
  'none',
  'temperror',
  'permerror',
  'policy',
] as const;
export type AuthVerdict = (typeof AUTH_VERDICTS)[number];

export interface MailAuthentication {
  /** SPF of the server that delivered the mail to Listora's receiver. */
  spf: AuthVerdict;
  /** The signing domains (`header.d`, else the domain of `header.i`) of DKIM signatures that passed. */
  dkimPassDomains: readonly string[];
  /** The receiver flagged the mail as spam or a virus (SES's scans). */
  flagged: boolean;
}

/** What a message proves when its receiver added no verdict Listora trusts: nothing. */
export const UNVERIFIED: MailAuthentication = { spf: 'none', dkimPassDomains: [], flagged: false };

interface AuthenticationResults {
  authservId: string;
  spf: AuthVerdict;
  dkimPassDomains: string[];
}

function verdict(value: string | undefined): AuthVerdict {
  return AUTH_VERDICTS.find((candidate) => candidate === value?.toLowerCase()) ?? 'none';
}

/** Reads one `Authentication-Results` header value (RFC 8601). */
export function parseAuthenticationResults(value: string): AuthenticationResults {
  // Comments may hold anything, semicolons included.
  let uncommented = value;
  for (let pass = 0; pass < 5 && /\([^()]*\)/.test(uncommented); pass += 1) {
    uncommented = uncommented.replace(/\([^()]*\)/g, ' ');
  }
  const [authservPart = '', ...methods] = uncommented.split(';');
  const authservId = authservPart.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  let spf: AuthVerdict = 'none';
  const dkimPassDomains: string[] = [];
  for (const method of methods) {
    const tokens = method.trim().split(/\s+/);
    const [name, result] = (tokens[0] ?? '').toLowerCase().split('=');
    const properties = new Map<string, string>();
    for (const token of tokens.slice(1)) {
      const at = token.indexOf('=');
      if (at > 0)
        properties.set(token.slice(0, at).toLowerCase(), token.slice(at + 1).replace(/^"|"$/g, ''));
    }
    if (name === 'spf' && spf === 'none') spf = verdict(result);
    if (name === 'dkim' && result === 'pass') {
      const domain =
        properties.get('header.d') ?? properties.get('header.i')?.split('@').at(-1) ?? '';
      if (domain !== '') dkimPassDomains.push(domain.toLowerCase().replace(/\.$/, ''));
    }
  }
  return { authservId, spf, dkimPassDomains };
}

/**
 * The verdicts of the message's first `Authentication-Results` header when the trusted
 * receiver (`authservId`) added it; otherwise nothing is verified.
 */
export function authenticationFromHeaders(
  message: Pick<MailMessage, 'headers'>,
  trustedAuthservId: string,
): MailAuthentication {
  const first = headerValues(message, 'authentication-results')[0];
  if (first === undefined) return UNVERIFIED;
  const results = parseAuthenticationResults(first);
  if (results.authservId !== trustedAuthservId.toLowerCase()) return UNVERIFIED;
  return { spf: results.spf, dkimPassDomains: results.dkimPassDomains, flagged: false };
}

export function isWithinDomain(domain: string, base: string): boolean {
  const lower = domain.toLowerCase();
  return lower === base || lower.endsWith(`.${base}`);
}

export type SenderCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether the mail proves it comes from `senderDomain` (the registered domain its From address
 * is in, such as `poshmark.com`). The reason, when it does not, is safe to log and store.
 */
export function checkSender(auth: MailAuthentication, senderDomain: string): SenderCheck {
  if (auth.flagged)
    return { ok: false, reason: 'The receiving server flagged it as spam or a virus.' };
  if (auth.spf !== 'pass') return { ok: false, reason: `SPF did not pass (${auth.spf}).` };
  if (!auth.dkimPassDomains.some((domain) => isWithinDomain(domain, senderDomain))) {
    return { ok: false, reason: `No DKIM signature of ${senderDomain} passed.` };
  }
  return { ok: true };
}
