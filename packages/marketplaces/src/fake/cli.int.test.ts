import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startNodeProcess, startOnFreePort, type StartedProcess } from '@listora/testing';

const entry = fileURLToPath(new URL('cli.ts', import.meta.url));

describe('fake marketplace command', () => {
  let fake: StartedProcess | undefined;

  afterEach(async () => {
    await fake?.stop();
    fake = undefined;
  });

  it('serves the fake marketplace at FAKE_MARKETPLACE_URL and stops on SIGTERM', async () => {
    const { url, started } = await startOnFreePort(async (port) => {
      const url = `http://127.0.0.1:${String(port)}`;
      const started = startNodeProcess(entry, {
        PATH: process.env['PATH'],
        FAKE_MARKETPLACE_URL: url,
      });
      try {
        await started.waitForLog((line) => line['msg'] === 'fake marketplace ready');
      } catch (error) {
        await started.stop();
        throw error;
      }
      return { url, started };
    });
    fake = started;

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
