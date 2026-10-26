import { generateKeyPairSync, verify } from 'node:crypto';
import {
  createServer,
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from 'node:http2';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@listora/shared';

import { ApnsPushSender, type ApnsConfig } from './apns.ts';
import { loadPushConfig, PushConfigError } from './config.ts';
import type { DeviceDirectory, DeviceToken } from './devices.ts';
import type { PushNotification } from './notification.ts';

const silent = createLogger({ service: 'apns-test', level: 'silent' });
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const notification: PushNotification = {
  accountId: 'account-1',
  category: 'item_sold',
  title: 'Sold on eBay',
  body: "Levi's jacket sold on eBay. Tap to delist it on Depop from your iPhone.",
  urgency: 'time_sensitive',
  threadId: 'item:1',
  data: { itemId: 'item-1', delistRunId: 'run-1' },
  wakesApp: true,
};

interface Received {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** A stand-in for APNs over cleartext HTTP/2, answering each token as told. */
async function fakeApns(answers: Record<string, { status: number; reason?: string }> = {}) {
  const received: Received[] = [];
  const server: Http2Server = createServer();
  server.on('stream', (stream: ServerHttp2Stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      received.push({
        headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      const token = String(headers[':path']).split('/').at(-1) ?? '';
      const answer = answers[token] ?? { status: 200 };
      stream.respond({ ':status': answer.status });
      stream.end(answer.reason === undefined ? '' : JSON.stringify({ reason: answer.reason }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    url,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

function devices(tokens: DeviceToken[]): DeviceDirectory & { forgotten: string[] } {
  const forgotten: string[] = [];
  return {
    forgotten,
    tokensFor: () => Promise.resolve(tokens.filter((token) => !forgotten.includes(token.token))),
    forget: (token) => {
      forgotten.push(token);
      return Promise.resolve();
    },
  };
}

const opened: { close: () => Promise<void> }[] = [];
const senders: ApnsPushSender[] = [];
afterEach(async () => {
  for (const sender of senders.splice(0)) sender.close();
  for (const server of opened.splice(0)) await server.close();
});

async function setup(
  tokens: DeviceToken[],
  answers?: Record<string, { status: number; reason?: string }>,
) {
  const apns = await fakeApns(answers);
  opened.push(apns);
  const config: ApnsConfig = {
    keyId: 'KEY1234567',
    teamId: 'TEAM123456',
    privateKey: PEM,
    topic: 'com.listora.app',
    endpoints: { sandbox: apns.url, production: apns.url },
  };
  const directory = devices(tokens);
  const sender = new ApnsPushSender(config, directory, silent);
  senders.push(sender);
  return { apns, directory, sender };
}

const token = (value: string): DeviceToken => ({ token: value, environment: 'sandbox' });
const signal = () => AbortSignal.timeout(5_000);

describe('the APNs driver', () => {
  it('sends a time-sensitive alert that also wakes the app, signed with the provider key', async () => {
    const { apns, sender } = await setup([token('aa11'), token('bb22')]);
    await sender.send(notification, signal());
    expect(apns.received).toHaveLength(2);
    const [first] = apns.received;
    expect(first?.headers).toMatchObject({
      ':method': 'POST',
      ':path': '/3/device/aa11',
      'apns-topic': 'com.listora.app',
      'apns-push-type': 'alert',
      'apns-priority': '10',
    });
    expect(first?.body).toEqual({
      aps: {
        alert: { title: notification.title, body: notification.body },
        sound: 'default',
        'interruption-level': 'time-sensitive',
        category: 'item_sold',
        'thread-id': 'item:1',
        'content-available': 1,
      },
      itemId: 'item-1',
      delistRunId: 'run-1',
    });
    // The bearer token is an ES256 JWT for the key and team, which the public key verifies.
    const jwt = String(first?.headers.authorization).replace(/^bearer /, '');
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY1234567',
    });
    expect(JSON.parse(Buffer.from(claims ?? '', 'base64url').toString())).toMatchObject({
      iss: 'TEAM123456',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header ?? ''}.${claims ?? ''}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(true);
  });

  it('wakes the app in the background without an alert', async () => {
    const { apns, sender } = await setup([token('aa11')]);
    await sender.sendBackground({ accountId: 'account-1', reason: 'phone_work' }, signal());
    expect(apns.received).toHaveLength(1);
    expect(apns.received[0]?.headers).toMatchObject({
      'apns-push-type': 'background',
      'apns-priority': '5',
    });
    expect(apns.received[0]?.body).toEqual({
      aps: { 'content-available': 1 },
      reason: 'phone_work',
    });
  });

  it('forgets a token APNs says is gone, and throws for a failure that clears', async () => {
    const { apns, directory, sender } = await setup([token('aa11'), token('bb22'), token('cc33')], {
      aa11: { status: 410, reason: 'Unregistered' },
      bb22: { status: 503, reason: 'ServiceUnavailable' },
    });
    await expect(sender.send({ ...notification, wakesApp: false }, signal())).rejects.toThrow(
      'APNs answered 503 (ServiceUnavailable)',
    );
    // Every device was tried, and only the gone one is forgotten.
    expect(apns.received.map((entry) => entry.headers[':path'])).toEqual([
      '/3/device/aa11',
      '/3/device/bb22',
      '/3/device/cc33',
    ]);
    expect(directory.forgotten).toEqual(['aa11']);
    expect(apns.received[2]?.body).not.toHaveProperty('aps.content-available');
  });

  it('reads its configuration, naming each bad key but never its value', () => {
    const env = {
      PUSH_DRIVER: 'apns',
      APNS_KEY_ID: 'KEY1234567',
      APNS_TEAM_ID: 'TEAM123456',
      APNS_PRIVATE_KEY: PEM.replaceAll('\n', '\\n'),
      APNS_TOPIC: 'com.listora.app',
    };
    expect(loadPushConfig(env)).toMatchObject({
      driver: 'apns',
      apns: {
        keyId: 'KEY1234567',
        teamId: 'TEAM123456',
        privateKey: PEM.trim(),
        topic: 'com.listora.app',
      },
    });
    const bad = () => loadPushConfig({ ...env, APNS_PRIVATE_KEY: 'not a key', APNS_KEY_ID: 'x' });
    expect(bad).toThrow(PushConfigError);
    expect(bad).toThrow(/APNS_KEY_ID[\s\S]*APNS_PRIVATE_KEY/);
    expect(bad).not.toThrow(/not a key/);
  });
});
