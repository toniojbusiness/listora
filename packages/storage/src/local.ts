import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import { sha256Hex } from '@listora/shared';

import {
  assertPublicKey,
  assertStorageKey,
  assertStoragePrefix,
  base64ToHex,
  CHECKSUM_SHA256_HEADER,
  hexToBase64,
  isStorageKey,
  listLimit,
  type ObjectStorage,
  type PutOptions,
  type StoredObjectInfo,
  type UploadTarget,
  type UploadTargetRequest,
} from './storage.ts';

/** Where the API serves the local driver: signed uploads (PUT) and public objects (GET). */
export const LOCAL_STORAGE_ROUTE_PREFIX = '/storage/';

export interface LocalDiskStorageOptions {
  /** Directory that holds every object, one file per key. */
  rootDir: string;
  /** How clients reach the API that serves this storage, such as `http://127.0.0.1:3000`. */
  baseUrl: string;
  /** HMAC key for upload URLs; at least 32 characters. */
  signingSecret: string;
  now?: () => Date;
}

/** A PUT to a local upload URL, as the API received it. */
export interface LocalUploadRequest {
  key: string;
  expires: string | undefined;
  signature: string | undefined;
  contentType: string | undefined;
  checksumSha256: string | undefined;
  body: Uint8Array;
}

export type LocalUploadResult =
  | { status: 'stored' }
  | { status: 'rejected'; reason: 'expired' | 'bad_signature' | 'checksum_mismatch' };

/**
 * Development storage: objects are files under `rootDir`, and upload URLs point at the API,
 * which hands each PUT to `acceptUpload`. Like an S3 presigned PUT, the URL's signature covers
 * the key, expiry, content type, size, and SHA-256, and the body must match that checksum, so
 * code written against this driver behaves the same on S3.
 */
export class LocalDiskStorage implements ObjectStorage {
  readonly driver = 'local';
  readonly #rootDir: string;
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #now: () => Date;

  constructor(options: LocalDiskStorageOptions) {
    if (options.signingSecret.length < 32) {
      throw new Error('the local storage signing secret must be at least 32 characters');
    }
    this.#rootDir = options.rootDir;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#secret = options.signingSecret;
    this.#now = options.now ?? (() => new Date());
  }

  createUploadTarget(request: UploadTargetRequest): Promise<UploadTarget> {
    assertStorageKey(request.key);
    const expires = String(Math.floor(request.expiresAt.getTime() / 1000));
    const checksum = hexToBase64(request.sha256);
    const signature = this.#sign(
      request.key,
      expires,
      request.contentType,
      request.byteSize,
      checksum,
    );
    const query = new URLSearchParams({ expires, signature });
    return Promise.resolve({
      method: 'PUT',
      url: `${this.#baseUrl}${LOCAL_STORAGE_ROUTE_PREFIX}${request.key}?${query.toString()}`,
      headers: [
        { name: 'content-type', value: request.contentType },
        { name: CHECKSUM_SHA256_HEADER, value: checksum },
      ],
      expiresAt: new Date(Number(expires) * 1000),
    });
  }

  /** Verifies and stores one upload; anything that was not signed exactly is rejected. */
  async acceptUpload(request: LocalUploadRequest): Promise<LocalUploadResult> {
    assertStorageKey(request.key);
    const { expires, signature, contentType, checksumSha256 } = request;
    if (
      expires === undefined ||
      !/^\d{1,12}$/.test(expires) ||
      signature === undefined ||
      contentType === undefined ||
      checksumSha256 === undefined
    ) {
      return { status: 'rejected', reason: 'bad_signature' };
    }
    const expected = this.#sign(
      request.key,
      expires,
      contentType,
      request.body.byteLength,
      checksumSha256,
    );
    if (!safeEqual(expected, signature)) return { status: 'rejected', reason: 'bad_signature' };
    if (Number(expires) * 1000 <= this.#now().getTime()) {
      return { status: 'rejected', reason: 'expired' };
    }
    if (sha256Hex(request.body) !== base64ToHex(checksumSha256)) {
      return { status: 'rejected', reason: 'checksum_mismatch' };
    }
    await this.put(request.key, request.body, { contentType });
    return { status: 'stored' };
  }

  async head(key: string): Promise<StoredObjectInfo | undefined> {
    const body = await this.get(key);
    return body === undefined ? undefined : { byteSize: body.byteLength, sha256: sha256Hex(body) };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.#path(key)));
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  /** Files keep no headers: the API derives the content type from the key when serving. */
  async put(key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    if (options.contentType === '') throw new Error('a stored object needs a content type');
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    // Write then rename, so a reader never sees half a file.
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, body);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  async list(prefix: string, limit?: number): Promise<string[]> {
    assertStoragePrefix(prefix);
    const max = listLimit(limit);
    let entries;
    try {
      entries = await readdir(this.#path(prefix.slice(0, -1)), {
        recursive: true,
        withFileTypes: true,
      });
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const keys = entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(this.#rootDir, join(entry.parentPath, entry.name)).split(sep).join('/'),
      )
      // A file `put` is still writing (a `.tmp` name) is not an object yet.
      .filter((key) => !key.endsWith('.tmp') && isStorageKey(key))
      .sort();
    return keys.slice(0, max);
  }

  publicUrl(key: string): string {
    assertPublicKey(key);
    return `${this.#baseUrl}${LOCAL_STORAGE_ROUTE_PREFIX}${key}`;
  }

  #path(key: string): string {
    assertStorageKey(key);
    return join(this.#rootDir, ...key.split('/'));
  }

  #sign(
    key: string,
    expires: string,
    contentType: string,
    byteSize: number,
    checksum: string,
  ): string {
    return createHmac('sha256', this.#secret)
      .update(['PUT', key, expires, contentType, String(byteSize), checksum].join('\n'))
      .digest('base64url');
  }
}

function safeEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
