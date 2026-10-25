import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startNodeProcess, type StartedProcess } from '@listora/testing';

import { FAKE_EBAY_CLIENT_ID, FAKE_EBAY_CLIENT_SECRET } from './constants.ts';

const entry = fileURLToPath(new URL('cli.ts', import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

describe('fake eBay command', () => {
  let fake: StartedProcess | undefined;

  afterEach(async () => {
    await fake?.stop();
    fake = undefined;
  });

  it('serves the fake eBay at EBAY_FAKE_URL and stops on SIGTERM', async () => {
    const url = `http://127.0.0.1:${String(await freePort())}`;
    fake = startNodeProcess(entry, { PATH: process.env['PATH'], EBAY_FAKE_URL: url });
    await fake.waitForLog((line) => line['msg'] === 'fake eBay ready');

    const response = await fetch(`${url}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${FAKE_EBAY_CLIENT_ID}:${FAKE_EBAY_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      token_type: 'Application Access Token',
      expires_in: 7200,
    });

    expect(await fake.stop('SIGTERM')).toBe(0);
    fake = undefined;
  });

  it('refuses a URL that is not on this machine', async () => {
    fake = startNodeProcess(entry, {
      PATH: process.env['PATH'],
      EBAY_FAKE_URL: 'https://api.ebay.com',
    });
    expect(await fake.waitForExit()).toBe(1);
  });
});
