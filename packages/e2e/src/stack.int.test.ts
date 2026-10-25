import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  E2E_EMAIL,
  E2E_SECOND_EMAIL,
  stackEnvironment,
  startLocalStack,
  type LocalStack,
} from './stack.ts';

describe('local e2e stack (real Postgres)', () => {
  let stack: LocalStack;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'listora-e2e-test-'));
    stack = await startLocalStack({ fakeAiFixturesDir: dir, logDir: join(dir, 'logs') });
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the API on its own port with a signed-in user, then stops and writes its logs', async () => {
    expect(stack.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(stack.email).toBe(E2E_EMAIL);

    const ready = await fetch(`${stack.apiUrl}/health/ready`);
    expect(ready.status).toBe(200);
    const usage = await fetch(`${stack.apiUrl}/v1/usage`, {
      headers: { authorization: `Bearer ${stack.accessToken}` },
    });
    expect(usage.status).toBe(200);
    const anonymous = await fetch(`${stack.apiUrl}/v1/usage`);
    expect(anonymous.status).toBe(401);

    // eBay is connected, through the fake eBay's consent page.
    const auth = { authorization: `Bearer ${stack.accessToken}` };
    const ebay = await fetch(`${stack.apiUrl}/v1/connections/ebay`, { headers: auth });
    expect(await ebay.json()).toMatchObject({ mode: 'api', status: 'connected' });

    // The control endpoint seeds a ready item and injects eBay faults.
    const seeded = await fetch(`${stack.controlUrl}/items`, { method: 'POST' });
    expect(seeded.status).toBe(201);
    const { id, sku } = (await seeded.json()) as { id: string; sku: string };
    expect(sku).toMatch(/^[A-Z0-9]+-\d{6}$/);
    const item = await fetch(`${stack.apiUrl}/v1/items/${id}`, { headers: auth });
    expect(await item.json()).toMatchObject({
      status: 'ready',
      photos: [{ status: 'ready' }, { status: 'ready' }],
    });
    // ...and an item already live on eBay, confirmed by the fake.
    const listed = await fetch(`${stack.controlUrl}/items/listed`, { method: 'POST' });
    expect(listed.status).toBe(201);
    const { listingId } = (await listed.json()) as { listingId: string };
    const listing = await fetch(`${stack.apiUrl}/v1/listings/${listingId}`, { headers: auth });
    expect(await listing.json()).toMatchObject({
      status: 'active',
      statusDisplay: { label: 'Active (confirmed by eBay)' },
    });
    const fault = await fetch(`${stack.controlUrl}/ebay/faults`, {
      method: 'POST',
      body: JSON.stringify({ action: 'end', fault: { type: 'reject' } }),
    });
    expect(fault.status).toBe(204);
    const refused = await fetch(`${stack.controlUrl}/ebay/faults`, {
      method: 'POST',
      body: JSON.stringify({ action: 'end', fault: { type: 'hang' } }),
    });
    expect(refused.status).toBe(422);
    expect((await fetch(`${stack.controlUrl}/ebay/faults`, { method: 'DELETE' })).status).toBe(204);

    // The control endpoint sets the eBay connection's health; Retry check runs in the worker.
    const setEbay = (status: string) =>
      fetch(`${stack.controlUrl}/connections/ebay`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
    const health = async () =>
      (await (await fetch(`${stack.apiUrl}/v1/connection-health`, { headers: auth })).json()) as {
        needsAttention: boolean;
        banner?: { label: string };
        connections: { statusDisplay: { label: string } }[];
      };
    expect((await setEbay('reauth_required')).status).toBe(204);
    expect(await health()).toMatchObject({
      needsAttention: true,
      banner: { label: 'Reconnect eBay' },
    });
    expect((await setEbay('degraded')).status).toBe(204);
    const check = await fetch(`${stack.apiUrl}/v1/connections/ebay/checks`, {
      method: 'POST',
      headers: { ...auth, 'idempotency-key': crypto.randomUUID() },
    });
    expect(check.status).toBe(202);
    let label = '';
    for (let tries = 0; tries < 50 && label !== 'Connected'; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      label = (await health()).connections[0]?.statusDisplay.label ?? '';
    }
    expect(label).toBe('Connected');
    expect((await setEbay('broken')).status).toBe(422);
    expect((await setEbay('connected')).status).toBe(204);

    await stack.stop();
    await expect(fetch(`${stack.apiUrl}/health/live`)).rejects.toThrow();
    await expect(fetch(`${stack.controlUrl}/items`, { method: 'POST' })).rejects.toThrow();
    const apiLog = await readFile(join(dir, 'logs', 'api.log'), 'utf8');
    expect(apiLog).toContain('Server listening at');
    const workerLog = await readFile(join(dir, 'logs', 'worker.log'), 'utf8');
    expect(workerLog).toContain('worker ready');
  }, 60_000);

  it("hands its settings to xcodebuild's test runner too", () => {
    expect(
      stackEnvironment({
        apiUrl: 'http://127.0.0.1:5',
        accessToken: 'token',
        email: 'a@b.c',
        controlUrl: 'http://127.0.0.1:6',
        marketplaces: 'ebay',
      }),
    ).toEqual({
      LISTORA_E2E_API_BASE_URL: 'http://127.0.0.1:5',
      LISTORA_E2E_ACCESS_TOKEN: 'token',
      LISTORA_E2E_EMAIL: 'a@b.c',
      LISTORA_E2E_CONTROL_URL: 'http://127.0.0.1:6',
      LISTORA_E2E_MARKETPLACES: 'ebay',
      TEST_RUNNER_LISTORA_E2E_API_BASE_URL: 'http://127.0.0.1:5',
      TEST_RUNNER_LISTORA_E2E_ACCESS_TOKEN: 'token',
      TEST_RUNNER_LISTORA_E2E_EMAIL: 'a@b.c',
      TEST_RUNNER_LISTORA_E2E_CONTROL_URL: 'http://127.0.0.1:6',
      TEST_RUNNER_LISTORA_E2E_MARKETPLACES: 'ebay',
    });
    expect(
      stackEnvironment({
        apiUrl: 'http://127.0.0.1:5',
        accessToken: 'token',
        email: 'a@b.c',
        controlUrl: 'http://127.0.0.1:6',
        marketplaces: 'all',
        secondSeller: { accessToken: 'second-token', email: 'd@e.f' },
      }),
    ).toMatchObject({
      LISTORA_E2E_MARKETPLACES: 'all',
      LISTORA_E2E_SECOND_ACCESS_TOKEN: 'second-token',
      LISTORA_E2E_SECOND_EMAIL: 'd@e.f',
      TEST_RUNNER_LISTORA_E2E_SECOND_ACCESS_TOKEN: 'second-token',
    });
  });

  it("refuses the full stack's control routes", async () => {
    const other = await startLocalStack({ fakeAiFixturesDir: dir });
    try {
      for (const [path, body] of [
        [
          '/automation/faults',
          { marketplace: 'poshmark', action: 'create', fault: { type: 'captcha' } },
        ],
        ['/ebay/sales', { sku: 'X-000001' }],
        ['/sessions/poshmark', {}],
      ] as const) {
        const answer = await fetch(`${other.controlUrl}${path}`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        expect(answer.status, path).toBe(404);
      }
      const listed = await fetch(`${other.controlUrl}/items/listed`, {
        method: 'POST',
        body: JSON.stringify({ marketplaces: ['poshmark'] }),
      });
      expect(listed.status).toBe(422);
    } finally {
      await other.stop();
    }
  }, 60_000);
});

describe('full local e2e stack: every marketplace (real Postgres, headless Chromium)', () => {
  let stack: LocalStack;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'listora-e2e-full-test-'));
    stack = await startLocalStack({
      fakeAiFixturesDir: dir,
      logDir: join(dir, 'logs'),
      marketplaces: 'all',
    });
  }, 90_000);

  afterAll(async () => {
    await stack.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const connections = async (token: string) =>
    (
      (await (
        await fetch(`${stack.apiUrl}/v1/connections`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { data: { marketplace: string; mode: string; status: string }[] }
    ).data.map(({ marketplace, mode, status }) => ({ marketplace, mode, status }));

  it("connects the seller's eBay and Depop APIs and links Poshmark and Mercari, and the second seller's Depop", async () => {
    expect(await connections(stack.accessToken)).toEqual([
      { marketplace: 'ebay', mode: 'api', status: 'connected' },
      { marketplace: 'depop', mode: 'api', status: 'connected' },
      { marketplace: 'poshmark', mode: 'automation', status: 'connected' },
      { marketplace: 'mercari', mode: 'automation', status: 'connected' },
    ]);
    const second = stack.secondSeller;
    expect(second?.email).toBe(E2E_SECOND_EMAIL);
    expect(await connections(second?.accessToken ?? '')).toEqual([
      { marketplace: 'ebay', mode: 'api', status: 'not_connected' },
      { marketplace: 'depop', mode: 'automation', status: 'connected' },
      { marketplace: 'poshmark', mode: 'assisted', status: 'not_connected' },
      { marketplace: 'mercari', mode: 'assisted', status: 'not_connected' },
    ]);
  });

  it('lists through every adapter, each confirmed by its read-back', async () => {
    const listed = await fetch(`${stack.controlUrl}/items/listed`, {
      method: 'POST',
      body: JSON.stringify({
        marketplaces: ['ebay', 'depop', 'poshmark', 'mercari'],
        // A category Depop's API maps.
        details: { category: 'clothing/tops/t_shirts' },
      }),
    });
    expect(listed.status).toBe(201);
    const { id } = (await listed.json()) as { id: string };
    const item = (await (
      await fetch(`${stack.apiUrl}/v1/items/${id}`, {
        headers: { authorization: `Bearer ${stack.accessToken}` },
      })
    ).json()) as {
      listings: { marketplace: string; mode: string; statusDisplay: { label: string } }[];
    };
    expect(
      item.listings
        .map((listing) => [listing.marketplace, listing.mode, listing.statusDisplay.label])
        .sort(),
    ).toEqual([
      ['depop', 'api', 'Active (confirmed by Depop)'],
      ['ebay', 'api', 'Active (confirmed by eBay)'],
      ['mercari', 'automation', 'Active (confirmed by Mercari)'],
      ['poshmark', 'automation', 'Active (confirmed by Poshmark)'],
    ]);
  }, 240_000);

  it('injects faults on every fake, refusing ones it does not know', async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${stack.controlUrl}${path}`, { method: 'POST', body: JSON.stringify(body) });
    expect(
      (
        await post('/automation/faults', {
          marketplace: 'mercari',
          action: 'create',
          fault: { type: 'captcha' },
        })
      ).status,
    ).toBe(204);
    expect(
      (await post('/depop/faults', { action: 'delete', fault: { type: 'server_error' } })).status,
    ).toBe(204);
    expect(
      (
        await post('/automation/faults', {
          marketplace: 'mercari',
          action: 'closet',
          fault: { type: 'captcha' },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post('/automation/faults', {
          marketplace: 'ebay',
          action: 'create',
          fault: { type: 'captcha' },
        })
      ).status,
    ).toBe(422);
    expect((await post('/ebay/sales', { sku: 'NOPE-000001' })).status).toBe(422);
    expect((await fetch(`${stack.controlUrl}/faults`, { method: 'DELETE' })).status).toBe(204);
    // A fresh session for the second seller's Depop, as relinking does.
    expect((await post('/sessions/depop', {})).status).toBe(201);
  });
});
