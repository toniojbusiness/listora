/**
 * Object storage behind one interface. The API hands out upload targets so clients send file
 * bytes straight to storage, and the worker reads uploads and writes derived images. Drivers:
 * `LocalDiskStorage` (development and tests, files under `.local/storage`, upload URLs signed
 * and served by the API) and `S3Storage` (production, presigned PUTs, CloudFront for public
 * objects).
 */

export const STORAGE_DRIVERS = ['local', 's3'] as const;
export type StorageDriverName = (typeof STORAGE_DRIVERS)[number];

/**
 * Keys under this prefix are public: anyone with the URL can read them, so their names must be
 * unguessable. Every other key is private and is never served to clients.
 */
export const PUBLIC_KEY_PREFIX = 'public/';

export const MAX_STORAGE_KEY_LENGTH = 1024;

/** Slash-separated segments of letters, digits, `.`, `_`, and `-`; no `.` or `..` segments. */
const KEY_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function isStorageKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_STORAGE_KEY_LENGTH) return false;
  return key
    .split('/')
    .every((segment) => KEY_SEGMENT.test(segment) && segment !== '.' && segment !== '..');
}

export function isPublicKey(key: string): boolean {
  return key.startsWith(PUBLIC_KEY_PREFIX) && isStorageKey(key);
}

/** Throws for a key that drivers must never touch (empty, too long, or with path tricks). */
export function assertStorageKey(key: string): void {
  if (!isStorageKey(key)) throw new StorageKeyError(key);
}

export class StorageKeyError extends Error {
  constructor(key: string) {
    // The key is not secret, but it may be long; show only its start.
    super(`invalid storage key: ${JSON.stringify(key.slice(0, 80))}`);
    this.name = 'StorageKeyError';
  }
}

export interface UploadTargetRequest {
  key: string;
  contentType: string;
  /** The exact number of bytes the client will send. */
  byteSize: number;
  /** Lowercase hex SHA-256 of those bytes; storage rejects any other body. */
  sha256: string;
  expiresAt: Date;
}

export interface HttpHeader {
  name: string;
  value: string;
}

/** Where and how a client sends one file: exactly this method, URL, and these headers. */
export interface UploadTarget {
  method: 'PUT';
  url: string;
  headers: HttpHeader[];
  expiresAt: Date;
}

export interface StoredObjectInfo {
  byteSize: number;
  /** Lowercase hex SHA-256 of the content, when the store checked or recorded it. */
  sha256?: string;
}

export interface PutOptions {
  contentType: string;
  cacheControl?: string;
}

export interface ObjectStorage {
  readonly driver: StorageDriverName;
  /**
   * A presigned upload of exactly `byteSize` bytes whose SHA-256 is `sha256`. Storage itself
   * rejects a body of another size or checksum, so a stored upload is the declared file.
   */
  createUploadTarget(request: UploadTargetRequest): Promise<UploadTarget>;
  /** Size (and checksum when known) of a stored object; undefined when there is none. */
  head(key: string): Promise<StoredObjectInfo | undefined>;
  /** The object's bytes; undefined when there is none. */
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, body: Uint8Array, options: PutOptions): Promise<void>;
  /** Deletes the object; deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
  /**
   * Up to `limit` (at most 1000) keys under `prefix`, a key prefix ending in `/`, in key order.
   * Deletions use it to find every object of an account, and to check none is left.
   */
  list(prefix: string, limit?: number): Promise<string[]>;
  /** The URL anyone can read a public key at (see `PUBLIC_KEY_PREFIX`). */
  publicUrl(key: string): string;
  /**
   * A short-lived URL that reads one object, private or not, until `expiresAt` (at most
   * `MAX_SIGNED_READ_SECONDS` away), answered with `Cache-Control: private, no-store`
   * (`PRIVATE_CACHE_CONTROL`) so no shared cache keeps it. Never through the CDN: it is how a
   * signed-in client reads what only its account may see (a package photo with the buyer's
   * label).
   */
  signedReadUrl(key: string, expiresAt: Date): Promise<string>;
  /**
   * Asks the CDN that serves public keys to drop its copies of these (deleted or moved) keys,
   * so their URLs stop answering before the cache would let them expire. Resolves once the
   * request is accepted; the local driver has no CDN and does nothing.
   */
  invalidatePublic(keys: readonly string[]): Promise<void>;
}

/** What a private object is served with: no cache, shared or not, keeps a copy. */
export const PRIVATE_CACHE_CONTROL = 'private, no-store';

/** The longest a signed read URL lasts. */
export const MAX_SIGNED_READ_SECONDS = 24 * 60 * 60;

/** The seconds until `expiresAt`; throws unless 1 to `MAX_SIGNED_READ_SECONDS`. */
export function signedReadSeconds(expiresAt: Date, now: Date): number {
  const seconds = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
  if (seconds < 1 || seconds > MAX_SIGNED_READ_SECONDS) {
    throw new RangeError('a signed read URL must expire between 1 second and 24 hours from now');
  }
  return seconds;
}

/** The SHA-256 checksum header S3 verifies (base64 of the digest); the local driver mirrors it. */
export const CHECKSUM_SHA256_HEADER = 'x-amz-checksum-sha256';

export function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

export function base64ToHex(base64: string): string {
  return Buffer.from(base64, 'base64').toString('hex');
}

/** The most keys one `list` call returns (S3's page size). */
export const MAX_LIST_KEYS = 1000;

/** Throws for a prefix that is not a valid key followed by `/`. */
export function assertStoragePrefix(prefix: string): void {
  if (!prefix.endsWith('/') || !isStorageKey(prefix.slice(0, -1))) {
    throw new StorageKeyError(prefix);
  }
}

export function listLimit(limit: number | undefined): number {
  const value = limit ?? MAX_LIST_KEYS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_KEYS) {
    throw new RangeError(`list limit must be 1 to ${String(MAX_LIST_KEYS)}`);
  }
  return value;
}

export function assertPublicKey(key: string): void {
  if (!isPublicKey(key)) throw new Error('only keys under public/ have a public URL');
}
