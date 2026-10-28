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

const TIME_CURSOR_VERSION = 't1';

/** Where a page ordered by a time, newest first, ended: the last row's time and id. */
export interface TimeCursor {
  /** To the millisecond, as the page's order compares it. */
  at: Date;
  id: string;
}

/** Opaque cursor for keyset pagination by a time and then the id (newest first). */
export function encodeTimeCursor(cursor: TimeCursor): string {
  return Buffer.from(`${TIME_CURSOR_VERSION}:${String(cursor.at.getTime())}:${cursor.id}`).toString(
    'base64url',
  );
}

/** The time and id a cursor continues after; `400 invalid_request` for anything else. */
export function decodeTimeCursor(cursor: string): TimeCursor {
  const [version, time, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  const at = Number(time);
  if (
    version !== TIME_CURSOR_VERSION ||
    !Number.isSafeInteger(at) ||
    id === undefined ||
    !UUID.test(id)
  ) {
    throw new ApiError(
      'invalid_request',
      'The page cursor is not valid. Start from the first page.',
    );
  }
  return { at: new Date(at), id };
}
