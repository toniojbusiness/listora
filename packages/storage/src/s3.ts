import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
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
  base64ToHex,
  CHECKSUM_SHA256_HEADER,
  hexToBase64,
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
  /** Base URL of the CloudFront distribution that serves the bucket's `public/` keys. */
  publicBaseUrl: string;
  now?: () => Date;
}

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
  readonly #now: () => Date;

  constructor(options: S3StorageOptions) {
    this.#client = options.client;
    this.#bucket = options.bucket;
    this.#publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');
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

  publicUrl(key: string): string {
    assertPublicKey(key);
    return `${this.#publicBaseUrl}/${key}`;
  }
}
