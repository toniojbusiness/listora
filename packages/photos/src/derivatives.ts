import { randomBytes } from 'node:crypto';

import type { JsonObject } from '@listora/db';

/**
 * The images derived from every photo. All are metadata-free sRGB JPEGs, turned upright, and
 * never larger than the upload (a smaller upload keeps its own size).
 *
 * - `original`: full size; the private source for later reprocessing.
 * - `ai`: 1024 px long edge; what the AI call sees (private).
 * - `thumbnail`: 400 px; the app's lists and grids (public).
 * - `listing`: 1600 px; what marketplaces fetch (public).
 */
export const DERIVATIVES = {
  original: { maxEdge: undefined, quality: 92, public: false },
  ai: { maxEdge: 1024, quality: 85, public: false },
  thumbnail: { maxEdge: 400, quality: 80, public: true },
  listing: { maxEdge: 1600, quality: 88, public: true },
} as const satisfies Record<
  string,
  { maxEdge: number | undefined; quality: number; public: boolean }
>;

export type DerivativeKind = keyof typeof DERIVATIVES;
export const DERIVATIVE_KINDS = Object.keys(DERIVATIVES) as DerivativeKind[];

/** One stored derivative, as `photo.derivatives[kind]` records it. */
export interface StoredDerivative {
  key: string;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
}

export type PhotoDerivatives = Record<DerivativeKind, StoredDerivative>;

/** Public derivatives are immutable: a reprocessed photo gets new keys. */
export const PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Storage keys. Uploads sit under one prefix so a storage lifecycle rule can expire the ones
 * never attached; private derivatives under the account and photo; public ones under a random
 * 128-bit token, so their URLs cannot be guessed and say nothing about the account.
 */
export const storageKeys = {
  upload: (accountId: string, uploadFileId: string): string =>
    `uploads/${accountId}/${uploadFileId}`,
  derivative: (
    accountId: string,
    photoId: string,
    publicToken: string,
    kind: DerivativeKind,
  ): string =>
    DERIVATIVES[kind].public
      ? `public/${publicToken}/${kind}.jpg`
      : `photos/${accountId}/${photoId}/${publicToken}/${kind}.jpg`,
  newPublicToken: (): string => randomBytes(16).toString('hex'),
  /** The prefixes that hold only `accountId`'s uploads and private derivatives. */
  accountPrefixes: (accountId: string): string[] => [
    `uploads/${accountId}/`,
    `photos/${accountId}/`,
  ],
};

/** Reads `photo.derivatives`; undefined until the photo is processed (an empty object). */
export function parsePhotoDerivatives(value: JsonObject): PhotoDerivatives | undefined {
  const derivatives: Partial<PhotoDerivatives> = {};
  for (const kind of DERIVATIVE_KINDS) {
    const entry = value[kind];
    if (!isStoredDerivative(entry)) return undefined;
    derivatives[kind] = entry;
  }
  return derivatives as PhotoDerivatives;
}

function isStoredDerivative(value: unknown): value is StoredDerivative {
  if (typeof value !== 'object' || value === null) return false;
  const { key, width, height, byteSize, sha256 } = value as Record<string, unknown>;
  return (
    typeof key === 'string' &&
    typeof width === 'number' &&
    typeof height === 'number' &&
    typeof byteSize === 'number' &&
    typeof sha256 === 'string'
  );
}
