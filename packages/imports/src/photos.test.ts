import { EventEmitter } from 'node:events';
import type { ClientRequest } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { HttpImportPhotoFetcher, MAX_IMPORT_PHOTO_BYTES, type PhotoRequest } from './photos.ts';

const PUBLIC = '93.184.216.34';
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

interface Sent {
  url: URL;
  options: RequestOptions;
  /** Where the connection would go: what the request's own `lookup` answers for its host. */
  connectsTo: unknown;
}

/** An https stand-in that answers every request with `reply`, recording each one. */
function network(reply: { status?: number; headers?: Record<string, string>; body?: Buffer[] }): {
  request: PhotoRequest;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const request: PhotoRequest = (url, options) => {
    const client = new EventEmitter() as EventEmitter & { end: () => void };
    client.end = () => {
      options.lookup?.(url.hostname, { all: false }, (error, address) => {
        sent.push({ url, options, connectsTo: error ?? address });
        const response = Object.assign(new PassThrough(), {
          statusCode: reply.status ?? 200,
          headers: { 'content-type': 'image/jpeg', ...reply.headers },
        });
        client.emit('response', response);
        for (const chunk of reply.body ?? [Buffer.from(JPEG)]) response.write(chunk);
        response.end();
      });
    };
    return client as unknown as ClientRequest;
  };
  return { request, sent };
}

describe('fetching an imported listing photo', () => {
  const signal = new AbortController().signal;

  it('resolves the host once and connects to the address it checked', async () => {
    const answers = [[PUBLIC], ['169.254.169.254']];
    const resolved: string[] = [];
    const { request, sent } = network({});
    const fetcher = new HttpImportPhotoFetcher({
      request,
      // A second lookup would answer the metadata address (DNS rebinding).
      resolve: (host) => {
        resolved.push(host);
        return Promise.resolve(answers.shift() ?? []);
      },
    });
    const bytes = await fetcher.fetch('https://images.example.com/p/1.jpg', signal);
    expect(bytes).toEqual(JPEG);
    expect(resolved).toEqual(['images.example.com']);
    expect(sent.map((one) => [one.url.hostname, one.connectsTo])).toEqual([
      ['images.example.com', PUBLIC],
    ]);
    // A lookup that asks for every address gets the same one.
    const all = await new Promise((resolve) => {
      sent[0]?.options.lookup?.('images.example.com', { all: true }, (_error, addresses) => {
        resolve(addresses);
      });
    });
    expect(all).toEqual([{ address: PUBLIC, family: 4 }]);
  });

  it('refuses a host with any private address, and plain http, before connecting', async () => {
    const { request, sent } = network({});
    const fetcher = (addresses: string[]) =>
      new HttpImportPhotoFetcher({ request, resolve: () => Promise.resolve(addresses) });
    for (const addresses of [[PUBLIC, '10.0.0.7'], ['::1'], ['::ffff:127.0.0.1'], []]) {
      await expect(
        fetcher(addresses).fetch('https://images.example.com/p/1.jpg', signal),
      ).rejects.toThrow('public host only');
    }
    await expect(fetcher([PUBLIC]).fetch('https://169.254.169.254/latest', signal)).rejects.toThrow(
      'public host only',
    );
    await expect(fetcher([PUBLIC]).fetch('https://[fd00::1]/p.jpg', signal)).rejects.toThrow(
      'public host only',
    );
    await expect(
      fetcher([PUBLIC]).fetch('http://images.example.com/p.jpg', signal),
    ).rejects.toThrow('https only');
    await expect(
      fetcher([PUBLIC]).fetch('https://user:secret@images.example.com/p.jpg', signal),
    ).rejects.toThrow('no credentials');
    expect(sent).toEqual([]);
  });

  it('follows no redirect, and takes only an image within the size limit', async () => {
    const fetch = (reply: Parameters<typeof network>[0]) =>
      new HttpImportPhotoFetcher({
        request: network(reply).request,
        resolve: () => Promise.resolve([PUBLIC]),
      }).fetch('https://images.example.com/p/1.jpg', signal);
    await expect(
      fetch({ status: 302, headers: { location: 'https://169.254.169.254/' } }),
    ).rejects.toThrow('answered 302');
    await expect(fetch({ headers: { 'content-type': 'text/html' } })).rejects.toThrow('not a JPEG');
    await expect(
      fetch({ headers: { 'content-length': String(MAX_IMPORT_PHOTO_BYTES + 1) } }),
    ).rejects.toThrow('too large');
    // A body longer than the limit, without saying so, stops being read at the limit.
    const chunk = Buffer.alloc(1024 * 1024);
    const chunks = Array.from({ length: 16 }, () => chunk);
    await expect(fetch({ body: chunks })).rejects.toThrow('too large');
    await expect(fetch({ body: [] })).rejects.toThrow('empty');
  });
});
