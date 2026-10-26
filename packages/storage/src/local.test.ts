import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalDiskStorage, type LocalUploadRequest } from './local.ts';

const SECRET = 'local-storage-test-secret-0123456789abcdef';
const BODY = new TextEncoder().encode('jpeg bytes');
const SHA256 = createHash('sha256').update(BODY).digest('hex');

describe('LocalDiskStorage', () => {
  let rootDir: string;
  let clock: { now: number };
  let storage: LocalDiskStorage;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'listora-storage-'));
    clock = { now: Date.parse('2026-10-24T12:00:00Z') };
    storage = new LocalDiskStorage({
      rootDir,
      baseUrl: 'http://127.0.0.1:3000/',
      signingSecret: SECRET,
      now: () => new Date(clock.now),
    });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  /** The PUT a client makes when it follows an upload target exactly. */
  async function uploadRequest(
    overrides: Partial<{ byteSize: number; sha256: string }> = {},
  ): Promise<LocalUploadRequest> {
    const target = await storage.createUploadTarget({
      key: 'uploads/acct/file',
      contentType: 'image/jpeg',
      byteSize: overrides.byteSize ?? BODY.byteLength,
      sha256: overrides.sha256 ?? SHA256,
      expiresAt: new Date(clock.now + 900_000),
    });
    const url = new URL(target.url);
    const header = (name: string) => target.headers.find((entry) => entry.name === name)?.value;
    return {
      key: url.pathname.replace('/storage/', ''),
      expires: url.searchParams.get('expires') ?? undefined,
      signature: url.searchParams.get('signature') ?? undefined,
      contentType: header('content-type'),
      checksumSha256: header('x-amz-checksum-sha256'),
      body: BODY,
    };
  }

  it('hands out a signed PUT to the API and stores a body that matches it', async () => {
    const target = await storage.createUploadTarget({
      key: 'uploads/acct/file',
      contentType: 'image/jpeg',
      byteSize: BODY.byteLength,
      sha256: SHA256,
      expiresAt: new Date(clock.now + 900_000),
    });
    expect(target.method).toBe('PUT');
    expect(target.url).toMatch(
      /^http:\/\/127\.0\.0\.1:3000\/storage\/uploads\/acct\/file\?expires=\d+&signature=[\w-]+$/,
    );
    expect(target.headers.map((header) => header.name)).toEqual([
      'content-type',
      'x-amz-checksum-sha256',
    ]);

    expect(await storage.acceptUpload(await uploadRequest())).toEqual({ status: 'stored' });
    expect(await storage.head('uploads/acct/file')).toEqual({
      byteSize: BODY.byteLength,
      sha256: SHA256,
    });
  });

  it('rejects a body of another size or checksum than the one signed', async () => {
    const wrongSize = await uploadRequest({ byteSize: BODY.byteLength + 1 });
    expect(await storage.acceptUpload(wrongSize)).toEqual({
      status: 'rejected',
      reason: 'bad_signature',
    });

    const otherFile = await uploadRequest({ sha256: 'c'.repeat(64) });
    expect(await storage.acceptUpload(otherFile)).toEqual({
      status: 'rejected',
      reason: 'checksum_mismatch',
    });
    expect(await storage.head('uploads/acct/file')).toBeUndefined();
  });

  it('rejects a changed key, type, or signature, and an expired URL', async () => {
    const request = await uploadRequest();
    const rejectedAs = async (changes: Partial<LocalUploadRequest>) =>
      storage.acceptUpload({ ...request, ...changes });

    expect(await rejectedAs({ key: 'uploads/acct/other' })).toMatchObject({
      reason: 'bad_signature',
    });
    expect(await rejectedAs({ contentType: 'image/png' })).toMatchObject({
      reason: 'bad_signature',
    });
    expect(await rejectedAs({ signature: 'x'.repeat(43) })).toMatchObject({
      reason: 'bad_signature',
    });
    expect(await rejectedAs({ signature: undefined })).toMatchObject({ reason: 'bad_signature' });
    expect(await rejectedAs({ expires: 'soon' })).toMatchObject({ reason: 'bad_signature' });

    clock.now += 900_001;
    expect(await storage.acceptUpload(request)).toEqual({ status: 'rejected', reason: 'expired' });
    expect(await storage.head('uploads/acct/file')).toBeUndefined();
  });

  it('writes, reads, and deletes files under its root only', async () => {
    await storage.put('photos/acct/photo/original.jpg', BODY, { contentType: 'image/jpeg' });
    expect(Buffer.from((await storage.get('photos/acct/photo/original.jpg')) ?? [])).toEqual(
      Buffer.from(BODY),
    );
    expect(await readdir(join(rootDir, 'photos', 'acct', 'photo'))).toEqual(['original.jpg']);

    await storage.delete('photos/acct/photo/original.jpg');
    expect(await storage.get('photos/acct/photo/original.jpg')).toBeUndefined();
    await storage.delete('photos/acct/photo/original.jpg');

    await expect(storage.get('../outside')).rejects.toThrow('invalid storage key');
    await expect(storage.put('a//b', BODY, { contentType: 'image/jpeg' })).rejects.toThrow(
      'invalid storage key',
    );
  });

  it('lists the keys under a prefix, in order and up to a limit', async () => {
    const put = (key: string) => storage.put(key, BODY, { contentType: 'image/jpeg' });
    await put('photos/acct-1/photo-b/token/original.jpg');
    await put('photos/acct-1/photo-a/token/ai.jpg');
    await put('photos/acct-2/photo-c/token/ai.jpg');
    expect(await storage.list('photos/acct-1/')).toEqual([
      'photos/acct-1/photo-a/token/ai.jpg',
      'photos/acct-1/photo-b/token/original.jpg',
    ]);
    expect(await storage.list('photos/acct-1/', 1)).toEqual(['photos/acct-1/photo-a/token/ai.jpg']);
    expect(await storage.list('photos/acct-3/')).toEqual([]);
    await expect(storage.list('photos/acct-1')).rejects.toThrow(/invalid storage key/);
    await expect(storage.list('../')).rejects.toThrow(/invalid storage key/);
    await expect(storage.list('photos/', 1001)).rejects.toThrow(RangeError);
  });

  it('serves only public keys at a public URL', () => {
    expect(storage.publicUrl('public/token/thumbnail.jpg')).toBe(
      'http://127.0.0.1:3000/storage/public/token/thumbnail.jpg',
    );
    expect(() => storage.publicUrl('uploads/acct/file')).toThrow('public/');
  });

  it('needs a signing secret of at least 32 characters', () => {
    expect(
      () => new LocalDiskStorage({ rootDir, baseUrl: 'http://x', signingSecret: 'short' }),
    ).toThrow('at least 32 characters');
  });
});
