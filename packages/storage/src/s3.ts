import { createHash } from 'node:crypto';

import { CreateInvalidationCommand, type CloudFrontClient } from '@aws-sdk/client-cloudfront';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  assertPublicKey,
  assertStorageKey,
  assertStoragePrefix,
  base64ToHex,
  CHECKSUM_SHA256_HEADER,
  hexToBase64,
  listLimit,
  PRIVATE_CACHE_CONTROL,
  PUBLIC_KEY_PREFIX,
  signedReadSeconds,
  type ObjectStorage,
  type PutOptions,
  type StoredObjectInfo,
  type UploadTarget,
  type UploadTargetRequest,
} from './storage.ts';

/** S3 caps presigned URLs at seven days. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

export interface S3StorageOptions {
  client: S3Client;
  bucket: string;
  /**
   * Base URL of the CloudFront distribution that serves the bucket's `public/` keys. Its
   * origin path is `/public`, so a key's URL is the key without that prefix.
   */
  publicBaseUrl: string;
  /**
   * The CloudFront distribution at `publicBaseUrl` and a client for it, for `invalidatePublic`;
   * absent in a process that never invalidates (the API), where it throws.
   */
  cdn?: { client: CloudFrontClient; distributionId: string };
  now?: () => Date;
}

/** The most paths one invalidation request names (CloudFront's limit is 3,000). */
const MAX_INVALIDATION_PATHS = 1000;

export interface S3ClientSettings {
  region: string;
  /** Another S3-compatible endpoint (path-style addressing); AWS's own when absent. */
  endpoint?: string;
  /** Static credentials for tests; the default AWS provider chain when absent. */
  credentials?: S3ClientConfig['credentials'];
  /** Replaces the HTTP transport (tests use an in-memory fake). */
  requestHandler?: S3ClientConfig['requestHandler'];
}

/**
 * An S3 client that sends checksums only when a request names one. With the SDK's default
 * ("when supported") every request, presigned PUTs included, would carry a CRC32 that the
 * uploading client cannot know in advance.
 */
export function createS3Client(settings: S3ClientSettings): S3Client {
  return new S3Client({
    region: settings.region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(settings.endpoint === undefined
      ? {}
      : { endpoint: settings.endpoint, forcePathStyle: true }),
    ...(settings.credentials === undefined ? {} : { credentials: settings.credentials }),
    ...(settings.requestHandler === undefined ? {} : { requestHandler: settings.requestHandler }),
  });
}

/**
 * Production storage. Uploads are presigned PUTs that sign the content type, the exact
 * content length, and the `x-amz-checksum-sha256` header, so S3 stores only the declared
 * file: a different body fails S3's own checksum check, and a different size or type fails
 * the signature. Public keys are served through CloudFront at `publicBaseUrl`.
 */
export class S3Storage implements ObjectStorage {
  readonly driver = 's3';
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #publicBaseUrl: string;
  readonly #cdn: S3StorageOptions['cdn'];
  readonly #now: () => Date;

  constructor(options: S3StorageOptions) {
    this.#client = options.client;
    this.#bucket = options.bucket;
    this.#publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');
    this.#cdn = options.cdn;
    this.#now = options.now ?? (() => new Date());
  }

  async createUploadTarget(request: UploadTargetRequest): Promise<UploadTarget> {
    assertStorageKey(request.key);
    const checksum = hexToBase64(request.sha256);
    const command = new PutObjectCommand({
      Bucket: this.#bucket,
      Key: request.key,
      ContentType: request.contentType,
      ContentLength: request.byteSize,
      ChecksumSHA256: checksum,
    });
    const seconds = Math.floor((request.expiresAt.getTime() - this.#now().getTime()) / 1000);
    if (seconds < 1 || seconds > MAX_PRESIGN_SECONDS) {
      throw new RangeError('an S3 upload URL must expire between 1 second and 7 days from now');
    }
    const url = await getSignedUrl(this.#client, command, {
      expiresIn: seconds,
      signingDate: this.#now(),
      signableHeaders: new Set(['content-type', 'content-length']),
      // Kept as a header (not a query parameter) so S3 checks the body against it.
      unhoistableHeaders: new Set([CHECKSUM_SHA256_HEADER]),
    });
    return {
      method: 'PUT',
      url,
      headers: [
        { name: 'content-type', value: request.contentType },
        { name: CHECKSUM_SHA256_HEADER, value: checksum },
      ],
      expiresAt: new Date(this.#now().getTime() + seconds * 1000),
    };
  }

  async head(key: string): Promise<StoredObjectInfo | undefined> {
    assertStorageKey(key);
    try {
      const output = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key, ChecksumMode: 'ENABLED' }),
      );
      const checksum = output.ChecksumSHA256;
      return {
        byteSize: output.ContentLength ?? 0,
        // A multipart upload reports a checksum of checksums ("...-3"), not the file's.
        ...(checksum === undefined || checksum.includes('-')
          ? {}
          : { sha256: base64ToHex(checksum) }),
      };
    } catch (error) {
      if (error instanceof NotFound || error instanceof NoSuchKey) return undefined;
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    assertStorageKey(key);
    try {
      const output = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      if (output.Body === undefined) throw new Error(`S3 returned no body for ${key}`);
      return await output.Body.transformToByteArray();
    } catch (error) {
      if (error instanceof NoSuchKey || error instanceof NotFound) return undefined;
      throw error;
    }
  }

  async put(key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    assertStorageKey(key);
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ...(options.cacheControl === undefined ? {} : { CacheControl: options.cacheControl }),
      }),
    );
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  async list(prefix: string, limit?: number): Promise<string[]> {
    assertStoragePrefix(prefix);
    const output = await this.#client.send(
      new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: prefix, MaxKeys: listLimit(limit) }),
    );
    return (output.Contents ?? []).flatMap((object) =>
      object.Key === undefined ? [] : [object.Key],
    );
  }

  publicUrl(key: string): string {
    assertPublicKey(key);
    return `${this.#publicBaseUrl}/${key.slice(PUBLIC_KEY_PREFIX.length)}`;
  }

  /** A presigned GET of S3 itself (never CloudFront), whose answer S3 marks `private, no-store`. */
  async signedReadUrl(key: string, expiresAt: Date): Promise<string> {
    assertStorageKey(key);
    const now = this.#now();
    return getSignedUrl(
      this.#client,
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        ResponseCacheControl: PRIVATE_CACHE_CONTROL,
      }),
      { expiresIn: signedReadSeconds(expiresAt, now), signingDate: now },
    );
  }

  async invalidatePublic(keys: readonly string[]): Promise<void> {
    for (const key of keys) assertPublicKey(key);
    if (keys.length === 0) return;
    if (this.#cdn === undefined) {
      throw new Error('no CDN distribution is configured (STORAGE_CDN_DISTRIBUTION_ID)');
    }
    const paths = [...new Set(keys)].map((key) => `/${key.slice(PUBLIC_KEY_PREFIX.length)}`);
    for (let start = 0; start < paths.length; start += MAX_INVALIDATION_PATHS) {
      const batch = paths.slice(start, start + MAX_INVALIDATION_PATHS);
      await this.#cdn.client.send(
        new CreateInvalidationCommand({
          DistributionId: this.#cdn.distributionId,
          InvalidationBatch: {
            // The same paths are the same request, so a retry never starts a second one.
            CallerReference: invalidationReference(batch),
            Paths: { Quantity: batch.length, Items: batch },
          },
        }),
      );
    }
  }
}

function invalidationReference(paths: readonly string[]): string {
  return createHash('sha256').update(paths.join('\n')).digest('hex');
}
