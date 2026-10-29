import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import { createDatabase } from '@listora/db';
import { LocalDiskStorage } from '@listora/storage';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type AppDependencies } from './app.ts';
import {
  acceptedEncoding,
  COMPRESS_THRESHOLD_BYTES,
  COMPRESSION_OPT_IN_HEADER,
} from './compression.ts';
import { offlineDependencies, TEST_AUTH_SECRET } from './test-support.ts';

describe('response compression', () => {
  // Never connected: these routes do not reach the database.
  const db = createDatabase({ connectionString: 'postgres://listora@127.0.0.1:1/unused' });
  const auth: AppDependencies['auth'] = {
    provider: 'dev',
    verifyAccessToken: () => Promise.resolve(undefined),
  };
  const large = { rows: Array.from({ length: 200 }, (_, index) => ({ index, title: 'Fleece' })) };
  let rootDir: string;
  let app: ReturnType<typeof buildApp> | undefined;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'listora-compression-'));
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    await db.destroy();
    await rm(rootDir, { recursive: true, force: true });
  });

  function start(): NonNullable<typeof app> {
    const storage = new LocalDiskStorage({
      rootDir,
      baseUrl: 'http://localhost',
      signingSecret: TEST_AUTH_SECRET,
    });
    const built = buildApp({
      db,
      auth,
      ...offlineDependencies(),
      storage,
      pingDatabase: () => Promise.resolve(),
    });
    built.get('/test/large', () => large);
    app = built;
    return built;
  }

  it('sends a large JSON answer brotli-compressed to a client that accepts it', async () => {
    const response = await start().inject({
      method: 'GET',
      url: '/test/large',
      headers: { 'accept-encoding': 'gzip, deflate, br', [COMPRESSION_OPT_IN_HEADER]: 'accepted' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('br');
    expect(response.headers.vary).toContain('accept-encoding');
    const body = brotliDecompressSync(response.rawPayload).toString();
    expect(JSON.parse(body)).toEqual(large);
    expect(response.rawPayload.length * 4).toBeLessThan(Buffer.byteLength(body));
  });

  it('sends gzip to a client that accepts only gzip', async () => {
    const response = await start().inject({
      method: 'GET',
      url: '/test/large',
      headers: { 'accept-encoding': 'gzip', [COMPRESSION_OPT_IN_HEADER]: 'accepted' },
    });
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(response.rawPayload).toString())).toEqual(large);
  });

  it('sends the answer as it is to a client that accepts no encoding', async () => {
    const response = await start().inject({
      method: 'GET',
      url: '/test/large',
      headers: { [COMPRESSION_OPT_IN_HEADER]: 'accepted' },
    });
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.json()).toEqual(large);
  });

  it('sends the answer as it is to a client that does not ask for compression', async () => {
    // The app builds from before compression: URLSession accepts br and gzip on its own.
    const response = await start().inject({
      method: 'GET',
      url: '/test/large',
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers.vary).toContain(COMPRESSION_OPT_IN_HEADER);
    expect(response.json()).toEqual(large);
  });

  it('leaves an answer under the threshold as it is', async () => {
    const response = await start().inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'accept-encoding': 'br, gzip', [COMPRESSION_OPT_IN_HEADER]: 'accepted' },
    });
    expect(response.payload.length).toBeLessThan(COMPRESS_THRESHOLD_BYTES);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('never compresses a stored photo', async () => {
    const built = start();
    const jpeg = new Uint8Array(4 * COMPRESS_THRESHOLD_BYTES).fill(7);
    await new LocalDiskStorage({
      rootDir,
      baseUrl: 'http://localhost',
      signingSecret: TEST_AUTH_SECRET,
    }).put('public/photos/test.jpg', jpeg, { contentType: 'image/jpeg' });
    const response = await built.inject({
      method: 'GET',
      url: '/storage/public/photos/test.jpg',
      headers: { 'accept-encoding': 'br, gzip', [COMPRESSION_OPT_IN_HEADER]: 'accepted' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(new Uint8Array(response.rawPayload)).toEqual(jpeg);
  });
});

describe('acceptedEncoding', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['identity', null],
    ['gzip, deflate, br', 'br'],
    ['br;q=1.0, gzip;q=0.8, *;q=0.1', 'br'],
    ['gzip', 'gzip'],
    ['br;q=0, gzip', 'gzip'],
    ['deflate', null],
    ['*', 'br'],
    ['*;q=0', null],
    [['gzip', 'br'], 'br'],
  ] as const)('%j sends %j', (header, expected) => {
    expect(acceptedEncoding(header as string | string[] | undefined)).toBe(expected);
  });
});
