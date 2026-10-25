/**
 * Listing photos for automated listing forms. Marketplaces without an API take photos as file
 * uploads, so a create script fetches each photo's listing image (Listora's own public image
 * URL) and uploads the bytes through the form's file input, in posting order.
 */
import type { UploadFile } from '../runner/types.ts';

export interface PhotoSource {
  /** The photo at `url` as an upload; throws when it can't be fetched. */
  fetch(url: string, signal: AbortSignal): Promise<UploadFile>;
}

/** Listing images are at most a few megabytes; anything far larger is not one. */
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

/** Fetches photos over HTTPS (HTTP only for a local development host). */
export class HttpPhotoSource implements PhotoSource {
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async fetch(url: string, signal: AbortSignal): Promise<UploadFile> {
    const target = new URL(url);
    const local = target.hostname === '127.0.0.1' || target.hostname === 'localhost';
    if (target.protocol !== 'https:' && !(local && target.protocol === 'http:')) {
      throw new Error('photos are fetched over https only');
    }
    const response = await fetch(target, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`the photo answered ${String(response.status)}`);
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (mimeType !== 'image/jpeg') throw new Error('the photo is not a JPEG');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_PHOTO_BYTES) {
      throw new Error('the photo is empty or too large');
    }
    const name = target.pathname.split('/').at(-1) ?? 'photo.jpg';
    return { name: name.endsWith('.jpg') ? name : `${name}.jpg`, mimeType, buffer };
  }
}
