/**
 * What a worker's start logs (real Postgres): Graphile Worker warns at each runner's start that
 * its local queue (`LOCAL_QUEUE_SIZE`, 1) is smaller than its concurrency. The size is
 * deliberate, so the warning is kept at debug: it was in every deploy's warnings (38 in the week
 * to 2026-11-08 in the personal environment), where nobody acts on it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@listora/shared';

import { createEngineHarness, type EngineHarness } from './test-support.ts';

describe('a worker start (real Postgres)', () => {
  let harness: EngineHarness;

  beforeAll(async () => {
    harness = await createEngineHarness('worker_logs');
  });

  afterAll(async () => {
    await harness.close();
  });

  it("logs Graphile Worker's local queue warning at debug, not as a warning", async () => {
    const lines: { level: number; msg: string }[] = [];
    const logger = createLogger({
      service: 'worker',
      level: 'debug',
      destination: {
        write: (line: string) => lines.push(JSON.parse(line) as { level: number; msg: string }),
      },
    });
    // The operations runner (concurrency 4) and the background one (2), as deployed.
    const worker = await harness.startWorker({
      logger,
      tasks: { noop: async () => undefined },
    });
    await worker.stop();

    const batch = lines.filter((line) => line.msg.startsWith('Your job batch size'));
    expect(batch.map((line) => line.level)).toEqual([20, 20]);
    expect(lines.filter((line) => line.level >= 40)).toEqual([]);
  }, 30_000);
});
