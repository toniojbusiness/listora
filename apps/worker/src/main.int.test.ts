import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startNodeProcess, type StartedProcess } from '@listora/testing';

const entry = fileURLToPath(new URL('main.ts', import.meta.url));

describe('worker process', () => {
  let worker: StartedProcess | undefined;

  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
  });

  it('starts, reports ready, and exits 0 on SIGTERM', async () => {
    worker = startNodeProcess(entry, { PATH: process.env['PATH'], LOG_LEVEL: 'info' });
    await worker.waitForLog((line) => line['msg'] === 'worker ready');

    expect(await worker.stop('SIGTERM')).toBe(0);
    expect(worker.logs.map((line) => line['msg'])).toEqual([
      'worker ready',
      'shutting down',
      'shutdown complete',
    ]);
  });

  it('refuses to start with invalid configuration', async () => {
    worker = startNodeProcess(entry, {
      PATH: process.env['PATH'],
      LOG_LEVEL: 'invalid-level-value',
    });

    expect(await worker.waitForExit()).toBe(1);
    expect(worker.stderr).toContain('LOG_LEVEL must be one of');
    expect(worker.stderr).not.toContain('invalid-level-value');
    expect(worker.logs).toEqual([]);
  });
});
