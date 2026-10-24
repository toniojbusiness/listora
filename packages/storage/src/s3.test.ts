import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createS3Client, S3Storage } from './s3.ts';
import { FAKE_CREDENTIALS, FakeS3, sha256Base64 } from './test-support.ts';

const NOW = new Date('2026-10-24T12:00:00Z');
const BODY = new TextEncoder().encode('jpeg bytes');
const SHA256 = createHash('sha256').update(BODY).digest('hex');

function storage(fake = new FakeS3()) {
  return {
    fake,
    storage: new S3Storage({
      client: fake.client(),
      bucket: 'listora-photos',
      publicBaseUrl: 'https://cdn.example.com/',
      now: () => NOW,
    }),
  };
}

describe('S3Storage', () => {
  describe('createUploadTarget', () => {
    // Presigning is local computation; static fake credentials are enough.
    const presigner = new S3Storage({
      client: createS3Client({ region: 'us-east-1', credentials: FAKE_CREDENTIALS }),
      bucket: 'listora-photos',
      publicBaseUrl: 'https://cdn.example.com',
      now: () => NOW,
    });

    it('presigns a PUT that signs the type, exact size, and SHA-256 header', async () => {
      const target = await presigner.createUploadTarget({
        key: 'uploads/acct/file',
        contentType: 'image/jpeg',
        byteSize: 1234,
        sha256: SHA256,
        expiresAt: new Date(NOW.getTime() + 900_000),
      });
      const url = new URL(target.url);
      expect(target.method).toBe('PUT');
      expect(url.origin).toBe('https://listora-photos.s3.us-east-1.amazonaws.com');
      expect(url.pathname).toBe('/uploads/acct/file');
      expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(url.searchParams.get('X-Amz-Date')).toBe('20261024T120000Z');
      expect(url.searchParams.get('X-Amz-Credential')).toBe(
        `${FAKE_CREDENTIALS.accessKeyId}/20261024/us-east-1/s3/aws4_request`,
      );
      expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual([
        'content-length',
        'content-type',
        'host',
        'x-amz-checksum-sha256',
      ]);
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
      // The checksum stays a header, so S3 verifies the body against it.
      expect(url.searchParams.has('x-amz-checksum-sha256')).toBe(false);
      expect(url.search).not.toMatch(/crc32/i);
      expect(target.headers).toEqual([
        { name: 'content-type', value: 'image/jpeg' },
        { name: 'x-amz-checksum-sha256', value: Buffer.from(SHA256, 'hex').toString('base64') },
      ]);
      expect(target.expiresAt).toEqual(new Date(NOW.getTime() + 900_000));
    });

    it('signs a different URL for a different size or checksum', async () => {
      const request = {
        key: 'uploads/acct/file',
        contentType: 'image/jpeg',
        byteSize: 1234,
        sha256: SHA256,
        expiresAt: new Date(NOW.getTime() + 900_000),
      };
      const signature = async (changes: Partial<typeof request>) =>
        new URL(
          (await presigner.createUploadTarget({ ...request, ...changes })).url,
        ).searchParams.get('X-Amz-Signature');
      const base = await signature({});
      expect(await signature({})).toBe(base);
      expect(await signature({ byteSize: 1235 })).not.toBe(base);
      expect(await signature({ sha256: 'b'.repeat(64) })).not.toBe(base);
      expect(await signature({ contentType: 'image/png' })).not.toBe(base);
    });

    it('refuses an expiry in the past or beyond seven days', async () => {
      const request = {
        key: 'uploads/acct/file',
        contentType: 'image/jpeg',
        byteSize: 1,
        sha256: SHA256,
      };
      await expect(presigner.createUploadTarget({ ...request, expiresAt: NOW })).rejects.toThrow(
        RangeError,
      );
      await expect(
        presigner.createUploadTarget({
          ...request,
          expiresAt: new Date(NOW.getTime() + 8 * 86_400_000),
        }),
      ).rejects.toThrow(RangeError);
    });

    it('rejects keys with path tricks before signing anything', async () => {
      await expect(
        presigner.createUploadTarget({
          key: 'uploads/../secrets',
          contentType: 'image/jpeg',
          byteSize: 1,
          sha256: SHA256,
          expiresAt: new Date(NOW.getTime() + 60_000),
        }),
      ).rejects.toThrow('invalid storage key');
    });
  });

  it('puts, heads (with the stored checksum), gets, and deletes objects', async () => {
    const { fake, storage: s3 } = storage();
    await s3.put('public/token/listing.jpg', BODY, {
      contentType: 'image/jpeg',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    const put = fake.requests.at(-1);
    expect(put).toMatchObject({
      method: 'PUT',
      bucket: 'listora-photos',
      key: 'public/token/listing.jpg',
    });
    expect(put?.headers['content-type']).toBe('image/jpeg');
    expect(put?.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    expect(await s3.head('public/token/listing.jpg')).toEqual({ byteSize: BODY.byteLength });
    expect(Buffer.from((await s3.get('public/token/listing.jpg')) ?? [])).toEqual(
      Buffer.from(BODY),
    );

    await s3.delete('public/token/listing.jpg');
    expect(await s3.head('public/token/listing.jpg')).toBeUndefined();
    expect(await s3.get('public/token/listing.jpg')).toBeUndefined();
    // Deleting again is not an error (S3 deletes are idempotent).
    await s3.delete('public/token/listing.jpg');
  });

  it('reports the SHA-256 S3 verified for an upload made with a checksum', async () => {
    const { fake, storage: s3 } = storage();
    fake.objects.set('listora-photos/uploads/acct/file', {
      body: Buffer.from(BODY),
      contentType: 'image/jpeg',
      cacheControl: undefined,
      checksumSha256: sha256Base64(BODY),
    });
    expect(await s3.head('uploads/acct/file')).toEqual({
      byteSize: BODY.byteLength,
      sha256: SHA256,
    });
    expect(fake.requests.at(-1)?.headers['x-amz-checksum-mode']).toBe('ENABLED');
  });

  it('ignores a multipart checksum, which is not the file’s SHA-256', async () => {
    const { fake, storage: s3 } = storage();
    fake.objects.set('listora-photos/uploads/acct/file', {
      body: Buffer.from(BODY),
      contentType: 'image/jpeg',
      cacheControl: undefined,
      checksumSha256: `${sha256Base64(BODY)}-2`,
    });
    expect(await s3.head('uploads/acct/file')).toEqual({ byteSize: BODY.byteLength });
  });

  it('surfaces S3 failures instead of treating them as a missing object', async () => {
    const { fake, storage: s3 } = storage();
    fake.failWith = 503;
    await expect(s3.get('uploads/acct/file')).rejects.toThrow();
    await expect(s3.head('uploads/acct/file')).rejects.toThrow();
    await expect(
      s3.put('uploads/acct/file', BODY, { contentType: 'image/jpeg' }),
    ).rejects.toThrow();
  });

  it('serves only public keys at the CloudFront URL, whose origin path is /public', () => {
    const { storage: s3 } = storage();
    expect(s3.publicUrl('public/abc/listing.jpg')).toBe('https://cdn.example.com/abc/listing.jpg');
    expect(() => s3.publicUrl('photos/acct/photo/original.jpg')).toThrow('public/');
  });
});
