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

    await stack.stop();
    await expect(fetch(`${stack.apiUrl}/health/live`)).rejects.toThrow();
    const apiLog = await readFile(join(dir, 'logs', 'api.log'), 'utf8');
    expect(apiLog).toContain('Server listening at');
    const workerLog = await readFile(join(dir, 'logs', 'worker.log'), 'utf8');
    expect(workerLog).toContain('worker ready');
  }, 60_000);

  it("hands its settings to xcodebuild's test runner too", () => {
    expect(
      stackEnvironment({ apiUrl: 'http://127.0.0.1:5', accessToken: 'token', email: 'a@b.c' }),
    ).toEqual({
      LISTORA_E2E_API_BASE_URL: 'http://127.0.0.1:5',
      LISTORA_E2E_ACCESS_TOKEN: 'token',
      LISTORA_E2E_EMAIL: 'a@b.c',
      TEST_RUNNER_LISTORA_E2E_API_BASE_URL: 'http://127.0.0.1:5',
      TEST_RUNNER_LISTORA_E2E_ACCESS_TOKEN: 'token',
      TEST_RUNNER_LISTORA_E2E_EMAIL: 'a@b.c',
    });
  });
});
