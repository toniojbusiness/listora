import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startNodeProcess, type StartedProcess } from '@listora/testing';

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

describe('fake marketplace command', () => {
  let fake: StartedProcess | undefined;

  afterEach(async () => {
    await fake?.stop();
    fake = undefined;
  });

  it('serves the fake marketplace at FAKE_MARKETPLACE_URL and stops on SIGTERM', async () => {
    const url = `http://127.0.0.1:${String(await freePort())}`;
    fake = startNodeProcess(entry, { PATH: process.env['PATH'], FAKE_MARKETPLACE_URL: url });
    await fake.waitForLog((line) => line['msg'] === 'fake marketplace ready');

    const response = await fetch(`${url}/depop/listings?sku=AJ-000184-D1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ listings: [] });

    expect(await fake.stop('SIGTERM')).toBe(0);
    fake = undefined;
  });

  it('refuses a URL that is not on this machine', async () => {
    fake = startNodeProcess(entry, {
      PATH: process.env['PATH'],
      FAKE_MARKETPLACE_URL: 'https://fake.example.com',
    });
    expect(await fake.waitForExit()).toBe(1);
  });
});
