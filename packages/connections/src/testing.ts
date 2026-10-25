/**
 * Test helpers for other workspaces, imported as `@listora/connections/testing`. Never imported
 * by runtime code.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { LocalTokenVault } from './local-vault.ts';

/** A local-key vault with a fresh random key. */
export function testTokenVault(): LocalTokenVault {
  return new LocalTokenVault(randomBytes(32));
}

/**
 * A fake AWS KMS for the KMS vault's tests: `GenerateDataKey` and `Decrypt` over the JSON 1.1
 * protocol the SDK speaks, with KMS's encryption-context rule (a blob decrypts only with the
 * context it was made with) and its `InvalidCiphertextException`. It checks no signature.
 */
export class FakeKms {
  readonly keyId = 'arn:aws:kms:us-east-1:111122223333:key/0b6f7b3e-0000-4000-8000-000000000001';
  /** Every call's operation name, oldest first. */
  readonly calls: string[] = [];
  /** The next call fails with this KMS error type (for example `KMSInternalException`). */
  failNext: string | undefined;
  readonly #server: Server;
  readonly #masterKey = randomBytes(32);
  #url = '';

  private constructor() {
    this.#server = createServer((request, response) => {
      void readJson(request).then((body) => {
        const target = String(request.headers['x-amz-target'] ?? '').replace('TrentService.', '');
        const answer = this.handle(target, body);
        response.writeHead(answer.status, { 'content-type': 'application/x-amz-json-1.1' });
        response.end(JSON.stringify(answer.body));
      });
    });
  }

  static async start(): Promise<FakeKms> {
    const fake = new FakeKms();
    await new Promise<void>((resolve) => fake.#server.listen(0, '127.0.0.1', resolve));
    fake.#url = `http://127.0.0.1:${String((fake.#server.address() as AddressInfo).port)}`;
    return fake;
  }

  get url(): string {
    return this.#url;
  }

  /** SDK client settings that reach this fake. */
  get clientConfig() {
    return {
      endpoint: this.url,
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' },
    };
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  handle(operation: string, body: Record<string, unknown>): { status: number; body: unknown } {
    this.calls.push(operation);
    if (this.failNext !== undefined) {
      const type = this.failNext;
      this.failNext = undefined;
      return { status: 500, body: { __type: type, message: 'injected failure' } };
    }
    if (body['KeyId'] !== this.keyId) {
      return { status: 400, body: { __type: 'NotFoundException', message: 'unknown key' } };
    }
    const context = canonical(body['EncryptionContext']);
    switch (operation) {
      case 'GenerateDataKey': {
        const dataKey = randomBytes(32);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.#masterKey, iv);
        cipher.setAAD(context);
        const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
        const blob = Buffer.concat([iv, cipher.getAuthTag(), wrapped]);
        return {
          status: 200,
          body: {
            KeyId: this.keyId,
            Plaintext: dataKey.toString('base64'),
            CiphertextBlob: blob.toString('base64'),
          },
        };
      }
      case 'Decrypt': {
        const blob = Buffer.from(String(body['CiphertextBlob']), 'base64');
        try {
          const decipher = createDecipheriv('aes-256-gcm', this.#masterKey, blob.subarray(0, 12));
          decipher.setAAD(context);
          decipher.setAuthTag(blob.subarray(12, 28));
          const dataKey = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
          return {
            status: 200,
            body: { KeyId: this.keyId, Plaintext: dataKey.toString('base64') },
          };
        } catch {
          return {
            status: 400,
            body: { __type: 'InvalidCiphertextException', message: 'invalid ciphertext' },
          };
        }
      }
      default:
        return { status: 400, body: { __type: 'UnknownOperationException' } };
    }
  }
}

function canonical(context: unknown): Buffer {
  const entries = Object.entries((context ?? {}) as Record<string, string>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return Buffer.from(JSON.stringify(entries));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) text += (chunk as Buffer).toString();
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}
