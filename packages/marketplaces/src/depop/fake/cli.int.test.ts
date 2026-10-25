import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startNodeProcess, type StartedProcess } from '@listora/testing';

import {
  FAKE_DEPOP_CLIENT_ID,
  FAKE_DEPOP_CLIENT_SECRET,
  FAKE_DEPOP_REFRESH_TOKEN,
} from './constants.ts';

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

describe('fake Depop command', () => {
  let fake: StartedProcess | undefined;

  afterEach(async () => {
    await fake?.stop();
    fake = undefined;
  });

  it("serves the fake Depop at DEPOP_FAKE_URL, renews the development seller's grant, and stops on SIGTERM", async () => {
    const url = `http://127.0.0.1:${String(await freePort())}`;
    fake = startNodeProcess(entry, { PATH: process.env['PATH'], DEPOP_FAKE_URL: url });
    await fake.waitForLog((line) => line['msg'] === 'fake Depop ready');

    const refresh = () =>
      fetch(`${url}/api/v1/oauth2/access-token/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: FAKE_DEPOP_REFRESH_TOKEN,
          client_id: FAKE_DEPOP_CLIENT_ID,
          client_secret: FAKE_DEPOP_CLIENT_SECRET,
        }).toString(),
      });
    // A restarted worker starts again from the configured token, which keeps working here.
    for (const attempt of [1, 2]) {
      const response = await refresh();
      expect(response.status, String(attempt)).toBe(200);
      expect(await response.json()).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    }

    expect(await fake.stop('SIGTERM')).toBe(0);
    fake = undefined;
  });

  it('refuses a URL that is not on this machine', async () => {
    fake = startNodeProcess(entry, {
      PATH: process.env['PATH'],
      DEPOP_FAKE_URL: 'https://partnerapi.depop.com',
    });
    expect(await fake.waitForExit()).toBe(1);
  });
});
