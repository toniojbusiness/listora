import { describe, expect, it } from 'vitest';

import { ApiError } from './errors.ts';
import { decodeCursor, encodeCursor } from './pagination.ts';

describe('cursors', () => {
  it('round-trips an id', () => {
    const id = '0190a2b8-0000-7000-8000-000000000000';
    expect(decodeCursor(encodeCursor(id))).toBe(id);
  });

  it.each([
    '',
    'garbage',
    Buffer.from('v2:0190a2b8-0000-7000-8000-000000000000').toString('base64url'),
  ])('rejects %j as invalid_request', (cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(ApiError);
  });
});
