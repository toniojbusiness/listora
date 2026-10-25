/**
 * Where the runner keeps the screenshot of a failed run: private object storage (the photo
 * bucket outside `public/`, or `.local/storage` locally), under `automation/<account>/`, never
 * served. Each is redacted before it is taken (session.ts) and deleted after
 * `SCREENSHOT_RETENTION_DAYS`, or with the account.
 */
import type { ObjectStorage } from '@listora/storage';

export const SCREENSHOT_PREFIX = 'automation/';
export const SCREENSHOT_RETENTION_DAYS = 14;

export interface ScreenshotStore {
  /** Stores a PNG; returns its key. */
  save(accountId: string, runId: string, png: Uint8Array): Promise<string>;
}

export function screenshotKey(accountId: string, runId: string): string {
  return `${SCREENSHOT_PREFIX}${accountId}/${runId}.png`;
}

export class StorageScreenshotStore implements ScreenshotStore {
  readonly #storage: ObjectStorage;

  constructor(storage: ObjectStorage) {
    this.#storage = storage;
  }

  async save(accountId: string, runId: string, png: Uint8Array): Promise<string> {
    const key = screenshotKey(accountId, runId);
    await this.#storage.put(key, png, { contentType: 'image/png', cacheControl: 'no-store' });
    return key;
  }
}

/** Keeps screenshots in memory (tests). */
export class MemoryScreenshotStore implements ScreenshotStore {
  readonly saved = new Map<string, Uint8Array>();

  save(accountId: string, runId: string, png: Uint8Array): Promise<string> {
    const key = screenshotKey(accountId, runId);
    this.saved.set(key, png);
    return Promise.resolve(key);
  }
}
