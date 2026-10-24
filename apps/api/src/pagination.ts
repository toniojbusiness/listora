import { ApiError } from './errors.ts';

/** Page size when the request gives none (the contract's `Limit` default). */
export const DEFAULT_PAGE_SIZE = 25;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_VERSION = 'v1';

/**
 * Opaque cursor for keyset pagination over UUIDv7 ids (newest first): the last id of a page,
 * versioned so the format can change without misreading old cursors.
 */
export function encodeCursor(lastId: string): string {
  return Buffer.from(`${CURSOR_VERSION}:${lastId}`).toString('base64url');
}

/** The id a cursor continues after; `400 invalid_request` for anything this server did not issue. */
export function decodeCursor(cursor: string): string {
  const [version, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  if (version !== CURSOR_VERSION || id === undefined || !UUID.test(id)) {
    throw new ApiError(
      'invalid_request',
      'The page cursor is not valid. Start from the first page.',
    );
  }
  return id;
}
