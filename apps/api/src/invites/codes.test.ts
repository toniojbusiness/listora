import { describe, expect, it } from 'vitest';

import {
  formatInviteCode,
  inviteCodeHint,
  inviteCodeSha256,
  newInviteCode,
  normalizeInviteCode,
} from './codes.ts';

describe('invite codes', () => {
  it('are 16 characters of Crockford base32, different every time', () => {
    const codes = new Set(Array.from({ length: 200 }, () => newInviteCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
  });

  it('show in groups of four, and read back from what people type', () => {
    const code = newInviteCode();
    expect(formatInviteCode(code)).toMatch(/^(.{4}-){3}.{4}$/);
    expect(normalizeInviteCode(formatInviteCode(code))).toBe(code);
    expect(normalizeInviteCode(` ${formatInviteCode(code).toLowerCase()} `)).toBe(code);
    expect(normalizeInviteCode('k7qd 3m9p xw2t h8ra')).toBe('K7QD3M9PXW2TH8RA');
    // Letters people mistake for digits.
    expect(normalizeInviteCode('O0IL-0000-0000-0000')).toBe('0011000000000000');
  });

  it('refuse anything that cannot be a code', () => {
    for (const typed of [
      '',
      'K7QD-3M9P-XW2T',
      'K7QD-3M9P-XW2T-H8RAX',
      'U7QD-3M9P-XW2T-H8RA',
      '#'.repeat(16),
    ]) {
      expect(normalizeInviteCode(typed), typed).toBeUndefined();
    }
  });

  it('hash to 32 bytes and hint with their last four characters', () => {
    expect(inviteCodeSha256('K7QD3M9PXW2TH8RA')).toHaveLength(32);
    expect(inviteCodeSha256('K7QD3M9PXW2TH8RA')).toEqual(inviteCodeSha256('K7QD3M9PXW2TH8RA'));
    expect(inviteCodeHint('K7QD3M9PXW2TH8RA')).toBe('H8RA');
  });
});
