import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { startNodeProcess } from '@listora/testing';

const entry = fileURLToPath(new URL('main.ts', import.meta.url));

describe('worker process', () => {
  it('starts, reports ready, and exits 0 on SIGTERM', async () => {
    const worker = startNodeProcess(entry, { PATH: process.env['PATH'], LOG_LEVEL: 'info' });
    await worker.waitForLog((line) => line['msg'] === 'worker ready');

    expect(await worker.stop('SIGTERM')).toBe(0);
    expect(worker.logs.map((line) => line['msg'])).toEqual([
      'worker ready',
      'shutting down',
      'shutdown complete',
    ]);
  });

  it('refuses to start with invalid configuration', async () => {
    const worker = startNodeProcess(entry, { PATH: process.env['PATH'], LOG_LEVEL: 'loud' });
    expect(await worker.stop('SIGTERM')).not.toBe(0);
  });
});
