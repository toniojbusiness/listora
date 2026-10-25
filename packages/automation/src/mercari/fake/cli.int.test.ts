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

describe('fake Mercari site command', () => {
  let site: StartedProcess | undefined;

  afterEach(async () => {
    await site?.stop();
    site = undefined;
  });

  it('serves the fake Mercari site at FAKE_MERCARI_SITE_URL and stops on SIGTERM', async () => {
    const url = `http://127.0.0.1:${String(await freePort())}`;
    site = startNodeProcess(entry, { PATH: process.env['PATH'], FAKE_MERCARI_SITE_URL: url });
    await site.waitForLog((line) => line['msg'] === 'fake Mercari site ready');

    // Without a session, every page sends the browser to Mercari's login page.
    const response = await fetch(`${url}/sell/`, { redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login/');
    expect(await (await fetch(`${url}/login/`)).text()).toContain('type="password"');

    expect(await site.stop('SIGTERM')).toBe(0);
    site = undefined;
  });

  it('refuses a URL that is not on this machine', async () => {
    site = startNodeProcess(entry, {
      PATH: process.env['PATH'],
      FAKE_MERCARI_SITE_URL: 'https://www.mercari.com',
    });
    expect(await site.waitForExit()).toBe(1);
  });
});
