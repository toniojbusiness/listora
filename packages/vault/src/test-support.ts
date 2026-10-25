/**
 * Test-only helpers for this package's tests (not exported from the package): an in-memory KMS
 * behind the SDK's HTTP transport, so tests exercise the real KMS client (signing, the JSON
 * protocol, error parsing) without AWS credentials or a network. Like KMS, it binds every data
 * key to its encryption context: decrypting under another context fails.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import type { KMSClientConfig } from '@aws-sdk/client-kms';

import { createKmsClient } from './kms-cipher.ts';

export const FAKE_KEY_ARN =
  'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555';
const FAKE_CREDENTIALS = { accessKeyId: 'AKIDFAKEFAKEFAKE', secretAccessKey: 'fake-secret' };

interface FakeRequest {
  headers: Record<string, string>;
  body?: unknown;
}

export class FakeKms {
  readonly calls: { operation: string; context: Record<string, string> }[] = [];
  /** While set, every request fails with this HTTP status and error type. */
  failWith: { status: number; type: string } | undefined;
  readonly #masterKey = randomBytes(32);

  readonly requestHandler = {
    handle: async (request: FakeRequest) => ({ response: await this.#handle(request) }),
  } as unknown as NonNullable<KMSClientConfig['requestHandler']>;

  client() {
    return createKmsClient({
      region: 'us-east-1',
      endpoint: 'http://kms.fake.test',
      credentials: FAKE_CREDENTIALS,
      requestHandler: this.requestHandler,
      maxAttempts: 1,
    });
  }

  async #handle(request: FakeRequest) {
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const operation = (headers['x-amz-target'] ?? '').replace('TrentService.', '');
    const input = JSON.parse((await readBody(request.body)).toString('utf8') || '{}') as {
      KeyId?: string;
      CiphertextBlob?: string;
      EncryptionContext?: Record<string, string>;
    };
    const context = input.EncryptionContext ?? {};
    this.calls.push({ operation, context });
    if (this.failWith !== undefined) {
      return reply(this.failWith.status, { __type: this.failWith.type, message: 'injected' });
    }
    const aad = Buffer.from(JSON.stringify(Object.entries(context).sort()));
    switch (operation) {
      case 'GenerateDataKey': {
        if (input.KeyId !== FAKE_KEY_ARN) {
          return reply(400, { __type: 'NotFoundException', message: 'no such key' });
        }
        const dataKey = randomBytes(32);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.#masterKey, iv);
        cipher.setAAD(aad);
        const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
        const blob = Buffer.concat([iv, cipher.getAuthTag(), wrapped]);
        return reply(200, {
          KeyId: FAKE_KEY_ARN,
          Plaintext: dataKey.toString('base64'),
          CiphertextBlob: blob.toString('base64'),
        });
      }
      case 'Decrypt': {
        const blob = Buffer.from(input.CiphertextBlob ?? '', 'base64');
        try {
          const decipher = createDecipheriv('aes-256-gcm', this.#masterKey, blob.subarray(0, 12));
          decipher.setAAD(aad);
          decipher.setAuthTag(blob.subarray(12, 28));
          const dataKey = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
          return reply(200, { KeyId: FAKE_KEY_ARN, Plaintext: dataKey.toString('base64') });
        } catch {
          return reply(400, { __type: 'InvalidCiphertextException', message: 'invalid' });
        }
      }
      default:
        return reply(400, { __type: 'UnsupportedOperationException', message: operation });
    }
  }
}

function reply(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'content-type': 'application/x-amz-json-1.1' },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  };
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
  throw new Error('unsupported request body');
}
