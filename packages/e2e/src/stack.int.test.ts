import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { E2E_EMAIL, stackEnvironment, startLocalStack, type LocalStack } from './stack.ts';

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
      }),
    ).toEqual({
      LISTORA_E2E_API_BASE_URL: 'http://127.0.0.1:5',
      LISTORA_E2E_ACCESS_TOKEN: 'token',
      LISTORA_E2E_EMAIL: 'a@b.c',
      LISTORA_E2E_CONTROL_URL: 'http://127.0.0.1:6',
      TEST_RUNNER_LISTORA_E2E_API_BASE_URL: 'http://127.0.0.1:5',
      TEST_RUNNER_LISTORA_E2E_ACCESS_TOKEN: 'token',
      TEST_RUNNER_LISTORA_E2E_EMAIL: 'a@b.c',
      TEST_RUNNER_LISTORA_E2E_CONTROL_URL: 'http://127.0.0.1:6',
    });
  });
});
