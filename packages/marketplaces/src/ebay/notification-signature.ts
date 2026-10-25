/**
 * Verifies that a notification came from eBay, as eBay's own event-notification SDKs do
 * (github.com/eBay/event-notification-nodejs-sdk, lib/validator.js; the Notification API
 * overview and `getPublicKey`, read 2026-10-24):
 *
 * 1. The `X-EBAY-SIGNATURE` header is the base64 of a JSON object
 *    `{ alg, kid, signature, digest }`.
 * 2. `getPublicKey(kid)` (application token) answers `{ key, algorithm, digest }`, the PEM key
 *    on one line.
 * 3. `signature` is a base64 DER ECDSA signature of the JSON body with that digest (SHA1).
 *
 * The body is checked as received. eBay's SDKs sign-check `JSON.stringify` of the parsed body,
 * so a body whose bytes differ from that form (whitespace) is also checked in that form; both
 * checks need eBay's signature, so neither accepts a forgery.
 *
 * Keys are cached for an hour, as eBay asks ("one-hour is recommended"; fetching the key for
 * every notification can exceed the Notification API's call limit). An unknown key id is
 * remembered for ten minutes, so a stream of forged headers with random ids costs at most one
 * `getPublicKey` call per id and the cache stays bounded. Fetches are single-flight per key id.
 *
 * `verify` never throws: it answers `valid`, `invalid` (reject the notification), or
 * `unavailable` (eBay's key could not be read now; answer with an error so eBay sends it again).
 */
import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

import type { ApplicationToken } from './oauth.ts';
import { rest, type RestEndpoints } from './rest.ts';

export type SignatureVerdict =
  | { type: 'valid' }
  /** Not signed by eBay: a missing, malformed, or wrong signature, or an unknown key. */
  | { type: 'invalid'; reason: SignatureRejection }
  /** eBay's key could not be read now; the notification should be delivered again. */
  | { type: 'unavailable'; code: string };

export type SignatureRejection =
  'missing_signature' | 'malformed_signature' | 'unknown_key' | 'unsupported_key' | 'bad_signature';

export interface NotificationVerifierOptions {
  endpoints: Pick<RestEndpoints, 'api'>;
  token: ApplicationToken;
  /** How long a fetched key is used (default one hour, eBay's recommendation). */
  keyTtlMs?: number;
  /** How long an unknown key id is remembered (default ten minutes). */
  unknownKeyTtlMs?: number;
  /** At most this many key ids are cached (default 256); the oldest entries go first. */
  maxCachedKeys?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** The longest header Listora decodes; eBay's is about 300 characters. */
const MAX_HEADER_LENGTH = 4096;
const DIGESTS = new Set(['SHA1', 'SHA256']);

interface CachedKey {
  /** `null`: eBay does not know this key id. */
  key: { object: KeyObject; digest: string } | null;
  expiresAt: number;
}

type KeyLookup =
  | { type: 'key'; object: KeyObject; digest: string }
  | { type: 'unknown' }
  | { type: 'unsupported' }
  | { type: 'unavailable'; code: string };

export class EbayNotificationVerifier {
  readonly #endpoints: Pick<RestEndpoints, 'api'>;
  readonly #token: ApplicationToken;
  readonly #keyTtlMs: number;
  readonly #unknownKeyTtlMs: number;
  readonly #maxCachedKeys: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, CachedKey>();
  readonly #fetching = new Map<string, Promise<KeyLookup>>();

  constructor(options: NotificationVerifierOptions) {
    this.#endpoints = options.endpoints;
    this.#token = options.token;
    this.#keyTtlMs = options.keyTtlMs ?? 60 * 60_000;
    this.#unknownKeyTtlMs = options.unknownKeyTtlMs ?? 10 * 60_000;
    this.#maxCachedKeys = options.maxCachedKeys ?? 256;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  async verify(
    body: string,
    signatureHeader: string | undefined,
    signal: AbortSignal,
  ): Promise<SignatureVerdict> {
    if (signatureHeader === undefined || signatureHeader === '') {
      return { type: 'invalid', reason: 'missing_signature' };
    }
    const header = decodeSignatureHeader(signatureHeader);
    if (header === undefined) return { type: 'invalid', reason: 'malformed_signature' };

    const lookup = await this.#key(header.kid, signal).catch((): KeyLookup => ({
      type: 'unavailable',
      code: 'aborted',
    }));
    switch (lookup.type) {
      case 'unavailable':
        return { type: 'unavailable', code: lookup.code };
      case 'unknown':
        return { type: 'invalid', reason: 'unknown_key' };
      case 'unsupported':
        return { type: 'invalid', reason: 'unsupported_key' };
      case 'key':
        break;
    }
    for (const candidate of signedForms(body)) {
      if (checkSignature(candidate, header.signature, lookup.object, lookup.digest)) {
        return { type: 'valid' };
      }
    }
    return { type: 'invalid', reason: 'bad_signature' };
  }

  async #key(kid: string, signal: AbortSignal): Promise<KeyLookup> {
    const cached = this.#cache.get(kid);
    if (cached !== undefined && cached.expiresAt > this.#now()) {
      return cached.key === null ? { type: 'unknown' } : { type: 'key', ...cached.key };
    }
    let fetching = this.#fetching.get(kid);
    if (fetching === undefined) {
      // The shared fetch belongs to no caller: it runs under its own timeout.
      fetching = this.#fetchKey(kid).finally(() => this.#fetching.delete(kid));
      this.#fetching.set(kid, fetching);
    }
    return abortable(fetching, signal);
  }

  async #fetchKey(kid: string): Promise<KeyLookup> {
    const signal = AbortSignal.timeout(this.#timeoutMs * 2);
    let token: string;
    try {
      token = await this.#token.get(signal);
    } catch (error) {
      return { type: 'unavailable', code: codeOf(error) ?? 'token_unavailable' };
    }
    const result = await rest(
      'GET',
      `${this.#endpoints.api}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`,
      { token, signal, timeoutMs: this.#timeoutMs },
      (body) => {
        const { key, algorithm, digest } = (body ?? {}) as Record<string, unknown>;
        if (typeof key !== 'string' || typeof algorithm !== 'string') return undefined;
        return { key, algorithm, digest: typeof digest === 'string' ? digest : 'SHA1' };
      },
    );
    switch (result.type) {
      case 'ok': {
        const { key, algorithm, digest } = result.value;
        const object = algorithm.toUpperCase() === 'ECDSA' ? publicKeyOf(key) : undefined;
        if (object === undefined || !DIGESTS.has(digest.toUpperCase())) {
          return { type: 'unsupported' };
        }
        this.#remember(kid, { object, digest: digest.toUpperCase() }, this.#keyTtlMs);
        return { type: 'key', object, digest: digest.toUpperCase() };
      }
      case 'error':
        if (result.status === 401) this.#token.forget(token);
        // eBay answers 404 for a key id it does not know; 400 for one it cannot read.
        if (result.status === 404 || result.status === 400) {
          this.#remember(kid, null, this.#unknownKeyTtlMs);
          return { type: 'unknown' };
        }
        return { type: 'unavailable', code: `http_${String(result.status)}` };
      case 'not_sent':
      case 'maybe_sent':
        return { type: 'unavailable', code: result.code };
    }
  }

  #remember(kid: string, key: CachedKey['key'], ttlMs: number): void {
    this.#cache.delete(kid);
    this.#cache.set(kid, { key, expiresAt: this.#now() + ttlMs });
    while (this.#cache.size > this.#maxCachedKeys) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}

/** The decoded `X-EBAY-SIGNATURE` header, or `undefined` when it is not one. */
export function decodeSignatureHeader(
  header: string,
): { kid: string; signature: string } | undefined {
  if (header.length > MAX_HEADER_LENGTH) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
  const { kid, signature } = (decoded ?? {}) as Record<string, unknown>;
  if (typeof kid !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(kid)) return undefined;
  if (typeof signature !== 'string' || signature === '') return undefined;
  return { kid, signature };
}

/** The forms of the body eBay's signature may cover: as received, then as eBay's SDKs check it. */
function signedForms(body: string): string[] {
  try {
    const compact = JSON.stringify(JSON.parse(body));
    return compact === body ? [body] : [body, compact];
  } catch {
    return [body];
  }
}

function checkSignature(body: string, signature: string, key: KeyObject, digest: string): boolean {
  try {
    const verifier = createVerify(digest);
    verifier.update(body);
    return verifier.verify(key, signature, 'base64');
  } catch {
    return false;
  }
}

/** eBay serves the PEM on one line; the header and footer need their own lines to parse. */
function publicKeyOf(key: string): KeyObject | undefined {
  const pem = key
    .replace(/-----BEGIN PUBLIC KEY-----\s*/, '-----BEGIN PUBLIC KEY-----\n')
    .replace(/\s*-----END PUBLIC KEY-----/, '\n-----END PUBLIC KEY-----');
  try {
    const object = createPublicKey(pem);
    return object.asymmetricKeyType === 'ec' ? object : undefined;
  } catch {
    return undefined;
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}
