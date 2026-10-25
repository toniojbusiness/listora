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

describe('fake Poshmark command', () => {
  let site: StartedProcess | undefined;

  afterEach(async () => {
    await site?.stop();
    site = undefined;
  });

  it('serves the fake Poshmark at FAKE_POSHMARK_URL and stops on SIGTERM', async () => {
    const url = `http://127.0.0.1:${String(await freePort())}`;
    site = startNodeProcess(entry, { PATH: process.env['PATH'], FAKE_POSHMARK_URL: url });
    await site.waitForLog((line) => line['msg'] === 'fake Poshmark ready');

    // Without a session, the listing form sends the browser to the login page, like Poshmark.
    const response = await fetch(`${url}/create-listing`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login?pmrd[url]=%2Fcreate-listing');
    expect(await (await fetch(`${url}/login`)).text()).toContain('type="password"');
    // Closets are public.
    expect((await fetch(`${url}/closet/listora_closet`)).status).toBe(200);

    expect(await site.stop('SIGTERM')).toBe(0);
    site = undefined;
  });

  it('refuses a URL that is not on this machine', async () => {
    site = startNodeProcess(entry, {
      PATH: process.env['PATH'],
      FAKE_POSHMARK_URL: 'https://poshmark.com',
    });
    expect(await site.waitForExit()).toBe(1);
  });
});
