import { describe, expect, it } from 'vitest';

import { purgeObjects } from './purge.ts';
import { S3Storage } from './s3.ts';
import { FakeS3 } from './test-support.ts';

const BODY = new TextEncoder().encode('bytes');

function s3(fake = new FakeS3()) {
  return new S3Storage({
    client: fake.client(),
    bucket: 'listora-photos',
    publicBaseUrl: 'https://cdn.example.com',
  });
}

describe('purgeObjects', () => {
  it('deletes the named keys and everything under the prefixes, and leaves the rest', async () => {
    const fake = new FakeS3();
    const storage = s3(fake);
    const keys = [
      'public/token-1/listing.jpg',
      'photos/acct-1/photo/token/original.jpg',
      'photos/acct-1/orphan/token/ai.jpg',
      'automation/acct-1/run.png',
      'photos/acct-2/photo/token/original.jpg',
      'public/token-2/listing.jpg',
    ];
    for (const key of keys) await storage.put(key, BODY, { contentType: 'image/jpeg' });

    const result = await purgeObjects(storage, {
      keys: ['public/token-1/listing.jpg', 'public/never-stored/listing.jpg'],
      prefixes: ['photos/acct-1/', 'automation/acct-1/', 'uploads/acct-1/'],
    });
    expect(result).toEqual({ deleted: 5, remaining: [] });
    expect([...fake.objects.keys()].sort()).toEqual([
      'listora-photos/photos/acct-2/photo/token/original.jpg',
      'listora-photos/public/token-2/listing.jpg',
    ]);
    // Done already: a repeat finds nothing left.
    expect(
      await purgeObjects(storage, {
        keys: ['public/token-1/listing.jpg'],
        prefixes: ['photos/acct-1/'],
      }),
    ).toEqual({ deleted: 1, remaining: [] });
  });

  it('reports what storage could not delete instead of throwing', async () => {
    const fake = new FakeS3();
    const storage = s3(fake);
    await storage.put('photos/acct-1/photo/token/ai.jpg', BODY, { contentType: 'image/jpeg' });
    fake.failWith = 503;
    expect(
      await purgeObjects(storage, {
        keys: ['public/token/listing.jpg'],
        prefixes: ['photos/acct-1/'],
      }),
    ).toEqual({ deleted: 0, remaining: ['public/token/listing.jpg', 'photos/acct-1/'] });
    fake.failWith = undefined;
    expect(
      await purgeObjects(storage, {
        keys: ['public/token/listing.jpg'],
        prefixes: ['photos/acct-1/'],
      }),
    ).toEqual({ deleted: 2, remaining: [] });
  });
});
