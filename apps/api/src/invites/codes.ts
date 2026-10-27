/**
 * Invite codes: 16 characters of Crockford's base32 (80 random bits), shown in groups of four
 * (`K7QD-3M9P-XW2T-H8RA`). The alphabet has no I, L, O, or U, and reading a code back forgives
 * case, spaces, dashes, and the letters people mistake for digits, so a code read aloud or typed
 * from a screenshot still works. Only a code's SHA-256 is stored.
 */
import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 16;
const GROUP = 4;
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${String(CODE_LENGTH)}}$`);

/** A new random code, without dashes. */
export function newInviteCode(): string {
  const bytes = randomBytes((CODE_LENGTH * 5) / 8);
  let bits = 0;
  let value = 0;
  let code = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      code += ALPHABET.charAt((value >> bits) & 31);
    }
  }
  return code;
}

/** `K7QD3M9PXW2TH8RA` → `K7QD-3M9P-XW2T-H8RA`. */
export function formatInviteCode(code: string): string {
  return (code.match(new RegExp(`.{1,${String(GROUP)}}`, 'g')) ?? []).join('-');
}

/** The code as typed, read back; undefined when it cannot be a code. */
export function normalizeInviteCode(typed: string): string | undefined {
  const code = typed.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (code.length !== CODE_LENGTH) return undefined;
  return CODE_PATTERN.test(code) ? code : undefined;
}

export function inviteCodeSha256(code: string): Buffer {
  return createHash('sha256').update(code).digest();
}

/** The last four characters, which the invite list shows to tell invites apart. */
export function inviteCodeHint(code: string): string {
  return code.slice(-GROUP);
}
