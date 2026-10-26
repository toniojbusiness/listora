/**
 * Each account's private forwarding address, `sales+<token>@<inbound domain>`. The token is
 * 100 random bits in lowercase base32, so an address cannot be guessed; mail reaches an account
 * only through its own token, and a message to any other address is dropped.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
/** Characters of a token: 20 base32 characters are 100 bits. */
export const ADDRESS_TOKEN_LENGTH = 20;
const LOCAL_PART_PREFIX = 'sales+';
const TOKEN = new RegExp(`^[a-z2-7]{${String(ADDRESS_TOKEN_LENGTH)}}$`);

/** A new random token. */
export function newAddressToken(): string {
  const bytes = randomBytes(ADDRESS_TOKEN_LENGTH);
  let token = '';
  // 256 is a multiple of 32, so each byte's low five bits are uniform.
  for (const byte of bytes) token += ALPHABET.charAt(byte % ALPHABET.length);
  return token;
}

export function forwardingAddress(token: string, inboundDomain: string): string {
  return `${LOCAL_PART_PREFIX}${token}@${inboundDomain}`;
}

/**
 * The token of a recipient address at the inbound domain, or undefined for any other address.
 * Matching ignores case (mail systems may change it) and display names (`Name <address>`).
 */
export function tokenOfRecipient(recipient: string, inboundDomain: string): string | undefined {
  const address = /<([^<>]+)>/.exec(recipient)?.[1] ?? recipient;
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 0 || lower.slice(at + 1) !== inboundDomain.toLowerCase()) return undefined;
  const local = lower.slice(0, at);
  if (!local.startsWith(LOCAL_PART_PREFIX)) return undefined;
  const token = local.slice(LOCAL_PART_PREFIX.length);
  return TOKEN.test(token) ? token : undefined;
}
