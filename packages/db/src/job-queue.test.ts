import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from '@listora/shared';

import { createJobQueueLogger } from './job-queue.ts';

describe('createJobQueueLogger', () => {
  it('writes Graphile Worker messages as structured lines, with info lowered to debug', () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = createJobQueueLogger(
      createLogger({ service: 'worker', level: 'debug', destination }),
    ).scope({ label: 'worker', workerId: 'pool-1' });

    logger.error('job failed', { attempts: 2 });
    logger.warn('slow job');
    logger.info('worker connected');
    logger.debug('polling');

    const lines = chunks
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as object);
    expect(lines).toEqual([
      expect.objectContaining({ level: 50, msg: 'job failed', attempts: 2 }),
      expect.objectContaining({ level: 40, msg: 'slow job' }),
      expect.objectContaining({ level: 20, msg: 'worker connected' }),
      expect.objectContaining({ level: 20, msg: 'polling' }),
    ]);
    expect(lines[0]).toMatchObject({
      service: 'worker',
      jobQueue: { label: 'worker', workerId: 'pool-1' },
    });
  });

  it('keeps a warning the caller expects at debug, and every other warning at warn', () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = createJobQueueLogger(
      createLogger({ service: 'worker', level: 'debug', destination }),
      { expectedWarnings: [/^Your job batch size \(1\) is smaller/] },
    ).scope({ label: 'worker' });

    logger.warn('Your job batch size (1) is smaller than your concurrency setting (5)');
    logger.warn('Your job batch size (2) is smaller than your concurrency setting (5)');

    const levels = chunks
      .join('')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { level: number }).level);
    expect(levels).toEqual([20, 40]);
  });
});
