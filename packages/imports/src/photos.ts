/**
 * An imported listing's photos (docs/features/imports.md): fetched from the marketplace's own
 * image CDN by the server, made a JPEG, and stored as an upload that the photo pipeline then
 * processes like any other (derivatives, metadata stripped, the upload deleted). The photo match
 * needs their perceptual hashes first, so each is computed here the pipeline's way.
 *
 * The URLs come from the seller's own session (the phone's or the runner's read of the
 * marketplace's pages), so a fetch is held to what a listing photo can be: https only (plain
 * http only for a local development host, when allowed), a host that resolves to public
 * addresses only, resolved once and connected to at the address checked, no redirects, an image
 * type, a size limit that stops the read, and a pixel limit.
 */
import { lookup } from 'node:dns/promises';
import { once } from 'node:events';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import { PHASH_SAMPLE_SIZE, perceptualHash } from '@listora/photos';
import { sha256Hex } from '@listora/shared';

/** Marketplace listing photos are a few megabytes at most; anything far larger is not one. */
export const MAX_IMPORT_PHOTO_BYTES = 15 * 1024 * 1024;
/** No listing photo is bigger, and uploads are held to the same (docs/features/photos.md). */
export const MAX_IMPORT_PHOTO_PIXELS = 4096 * 4096;
const FETCH_TIMEOUT_MS = 20_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface ImportPhotoFetcher {
  /** The photo's bytes; throws when it can't be fetched or is not an image. */
  fetch(url: string, signal: AbortSignal): Promise<Uint8Array>;
}

/** A photo ready to store: JPEG bytes, their sha256, its upright size, and its perceptual hash. */
export interface ImportedPhoto {
  jpeg: Uint8Array;
  sha256: string;
  width: number;
  height: number;
  phash: string;
}

/** Sends one request; `node:https`'s by default. */
export type PhotoRequest = (url: URL, options: RequestOptions) => ClientRequest;

export interface HttpImportPhotoFetcherOptions {
  /** Plain http to 127.0.0.1 and localhost, for the fake marketplaces in development. */
  allowLocalHttp?: boolean;
  /** How a host name resolves (tests stand in for DNS). */
  resolve?: (host: string) => Promise<string[]>;
  /** How an https request is sent (tests stand in for the network). */
  request?: PhotoRequest;
}

/** The one address a fetch connects to: the one that passed the check. */
interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export class HttpImportPhotoFetcher implements ImportPhotoFetcher {
  readonly #allowLocalHttp: boolean;
  readonly #resolve: (host: string) => Promise<string[]>;
  readonly #request: PhotoRequest;

  constructor(options: HttpImportPhotoFetcherOptions = {}) {
    this.#allowLocalHttp = options.allowLocalHttp ?? false;
    this.#resolve =
      options.resolve ??
      (async (host) => (await lookup(host, { all: true })).map((entry) => entry.address));
    this.#request = options.request ?? httpsRequest;
  }

  async fetch(url: string, signal: AbortSignal): Promise<Uint8Array> {
    const target = new URL(url);
    const local = target.hostname === '127.0.0.1' || target.hostname === 'localhost';
    const localHttp = local && this.#allowLocalHttp && target.protocol === 'http:';
    if (!(target.protocol === 'https:' || localHttp)) {
      throw new Error('listing photos are fetched over https only');
    }
    if (target.username !== '' || target.password !== '') {
      throw new Error('a listing photo URL carries no credentials');
    }
    const options: RequestOptions = {
      method: 'GET',
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      // Bytes as they are: a compressed body would get past the size limit.
      headers: { accept: 'image/jpeg, image/webp, image/png', 'accept-encoding': 'identity' },
    };
    let client: PhotoRequest = httpRequest;
    if (!localHttp) {
      // The host is resolved once, here, and the connection goes to the address that passed:
      // a DNS answer that changes between the check and the connection (rebinding) never
      // reaches a private address. The certificate is still checked against the host name.
      const pinned = await this.#publicAddress(target.hostname);
      options.lookup = pinnedLookup(pinned);
      client = this.#request;
    }
    return readPhoto(client(target, options));
  }

  async #publicAddress(hostname: string): Promise<PinnedAddress> {
    // An IPv6 literal is bracketed in a URL.
    const host = hostname.replace(/^\[(.*)\]$/, '$1');
    const addresses = isIP(host) === 0 ? await this.#resolve(host) : [host];
    const [address] = addresses;
    if (address === undefined || addresses.some(isPrivateAddress)) {
      throw new Error('a listing photo is on a public host only');
    }
    const family = isIP(address);
    if (family !== 4 && family !== 6) throw new Error('a listing photo is on a public host only');
    return { address, family };
  }
}

/** A `lookup` that answers every name with the pinned address, as one or as a list. */
export function pinnedLookup(pinned: PinnedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
}

/**
 * The photo's bytes: an answer other than 200 (a redirect included: none is followed), a type
 * other than an image, or a body past the size limit is refused, reading no more than that.
 */
async function readPhoto(request: ClientRequest): Promise<Uint8Array> {
  const responded = once(request, 'response');
  request.end();
  const [response] = (await responded) as [IncomingMessage];
  try {
    const status = response.statusCode ?? 0;
    if (status !== 200) throw new Error(`the photo answered ${String(status)}`);
    const type = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!IMAGE_TYPES.has(type)) throw new Error('the photo is not a JPEG, PNG, or WebP image');
    const declared = Number(response.headers['content-length'] ?? '0');
    if (declared > MAX_IMPORT_PHOTO_BYTES) throw new Error('the photo is too large');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_IMPORT_PHOTO_BYTES) throw new Error('the photo is too large');
      chunks.push(chunk);
    }
    if (size === 0) throw new Error('the photo is empty');
    return new Uint8Array(Buffer.concat(chunks, size));
  } finally {
    response.destroy();
  }
}

/**
 * The photo as Listora stores an upload: a JPEG (a PNG or WebP is converted), with its hashes.
 * Throws when the bytes are not an image.
 */
export async function importedPhoto(bytes: Uint8Array): Promise<ImportedPhoto> {
  const { default: sharp } = await import('sharp');
  const image = sharp(bytes, {
    failOn: 'error',
    limitInputPixels: MAX_IMPORT_PHOTO_PIXELS,
  }).rotate();
  const jpeg = isJpeg(bytes)
    ? bytes
    : new Uint8Array(await image.clone().jpeg({ quality: 90 }).toBuffer());
  const shown = await sharp(bytes, { limitInputPixels: MAX_IMPORT_PHOTO_PIXELS }).metadata();
  // Orientations 5 to 8 turn the image a quarter, so its upright width is its stored height.
  const turned = (shown.orientation ?? 1) >= 5;
  const width = turned ? shown.height : shown.width;
  const height = turned ? shown.width : shown.height;
  if (width < 1 || height < 1) {
    throw new Error('the photo has no size');
  }
  const grey = await image
    .clone()
    .greyscale()
    .resize(PHASH_SAMPLE_SIZE, PHASH_SAMPLE_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer();
  return {
    jpeg,
    sha256: sha256Hex(jpeg),
    width,
    height,
    phash: perceptualHash(new Uint8Array(grey)),
  };
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Loopback, private, link-local (where the cloud's metadata endpoint is), carrier-grade NAT,
 * multicast, and reserved addresses, IPv4 and IPv6 (and IPv4 written as IPv6).
 */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return isPrivateAddress(mapped);
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const lower = address.toLowerCase();
  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('ff')
  );
}
