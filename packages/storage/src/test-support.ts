/**
 * Test-only helpers for this package's tests (not exported from the package): an in-memory S3
 * behind the SDK's HTTP transport, so tests exercise the real S3 client (request signing,
 * serialization, error parsing) without AWS credentials or a network.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { S3ClientConfig } from '@aws-sdk/client-s3';

import { createS3Client } from './s3.ts';

export const FAKE_S3_ENDPOINT = 'http://s3.fake.test';
export const FAKE_CREDENTIALS = { accessKeyId: 'AKIDFAKEFAKEFAKE', secretAccessKey: 'fake-secret' };

interface StoredObject {
  body: Buffer;
  contentType: string | undefined;
  cacheControl: string | undefined;
  checksumSha256: string | undefined;
}

interface FakeRequest {
  method: string;
  hostname: string;
  path: string;
  query?: Record<string, string | string[] | null>;
  headers: Record<string, string>;
  body?: unknown;
}

export interface RecordedRequest {
  method: string;
  bucket: string;
  key: string;
  headers: Record<string, string>;
}

/** The S3 subset the driver uses: PutObject, HeadObject, GetObject, DeleteObject, ListObjectsV2. */
export class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly requests: RecordedRequest[] = [];
  /** While set, every request fails with this HTTP status (for example 503). */
  failWith: number | undefined;

  // The SDK's transport interface, with the request reduced to the fields the fake reads.
  readonly requestHandler = {
    handle: async (request: FakeRequest) => ({ response: await this.#handle(request) }),
  } as unknown as NonNullable<S3ClientConfig['requestHandler']>;

  client() {
    return createS3Client({
      region: 'us-east-1',
      endpoint: FAKE_S3_ENDPOINT,
      credentials: FAKE_CREDENTIALS,
      requestHandler: this.requestHandler,
    });
  }

  async #handle(request: FakeRequest) {
    const [, bucket = '', ...rest] = request.path.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    this.requests.push({ method: request.method, bucket, key, headers });
    const objectId = `${bucket}/${key}`;

    if (this.failWith !== undefined) {
      return response(this.failWith, {}, errorXml('ServiceUnavailable', 'Try again'));
    }

    switch (request.method) {
      case 'PUT': {
        const body = await readBody(request.body);
        const checksum = headers['x-amz-checksum-sha256'];
        if (checksum !== undefined && sha256Base64(body) !== checksum) {
          return response(400, {}, errorXml('BadDigest', 'The SHA256 you specified did not match'));
        }
        this.objects.set(objectId, {
          body,
          contentType: headers['content-type'],
          cacheControl: headers['cache-control'],
          checksumSha256: checksum,
        });
        return response(200, { etag: '"fake"' });
      }
      case 'HEAD': {
        const stored = this.objects.get(objectId);
        if (!stored) return response(404, {});
        return response(200, {
          'content-length': String(stored.body.byteLength),
          ...(stored.contentType === undefined ? {} : { 'content-type': stored.contentType }),
          ...(stored.checksumSha256 !== undefined && headers['x-amz-checksum-mode'] === 'ENABLED'
            ? { 'x-amz-checksum-sha256': stored.checksumSha256 }
            : {}),
        });
      }
      case 'GET': {
        if (key === '' && request.query?.['list-type'] === '2') return this.#list(bucket, request);
        const stored = this.objects.get(objectId);
        if (!stored) return response(404, {}, errorXml('NoSuchKey', 'The key does not exist'));
        return response(
          200,
          {
            'content-length': String(stored.body.byteLength),
            ...(stored.contentType === undefined ? {} : { 'content-type': stored.contentType }),
          },
          stored.body,
        );
      }
      case 'DELETE':
        this.objects.delete(objectId);
        return response(204, {});
      default:
        return response(405, {}, errorXml('MethodNotAllowed', request.method));
    }
  }

  /** ListObjectsV2: the bucket's keys under `prefix`, in key order, up to `max-keys`. */
  #list(bucket: string, request: FakeRequest) {
    const prefix = String(request.query?.['prefix'] ?? '');
    const maxKeys = Number(request.query?.['max-keys'] ?? 1000);
    const keys = [...this.objects.keys()]
      .filter((id) => id.startsWith(`${bucket}/${prefix}`))
      .map((id) => id.slice(bucket.length + 1))
      .sort()
      .slice(0, maxKeys);
    const contents = keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join('');
    return response(
      200,
      { 'content-type': 'application/xml' },
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name>` +
        `<Prefix>${prefix}</Prefix><KeyCount>${String(keys.length)}</KeyCount>` +
        `<MaxKeys>${String(maxKeys)}</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
    );
  }
}

function response(statusCode: number, headers: Record<string, string>, body?: Buffer | string) {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
  return {
    statusCode,
    headers: {
      ...(typeof body === 'string' ? { 'content-type': 'application/xml' } : {}),
      ...headers,
    },
    body: Readable.from([bytes]),
  };
}

function errorXml(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

async function readBody(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  }
  throw new Error(`fake S3 cannot read a body of type ${typeof body}`);
}

export function sha256Base64(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('base64');
}
