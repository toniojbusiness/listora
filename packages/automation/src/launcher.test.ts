import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRunnerLauncher,
  EcsServiceRunnerLauncher,
  loadRunnerLaunchConfig,
  ProcessRunnerLauncher,
  RunnerLaunchConfigError,
  scaleRunnerServiceToZero,
} from './launcher.ts';
import { silentLogger } from './test-support.ts';

class FakeEcs {
  readonly sent: { cluster?: string; service?: string; desiredCount?: number }[] = [];
  failWith: Error | undefined;

  send(command: unknown): Promise<object> {
    if (!(command instanceof UpdateServiceCommand)) throw new Error('unexpected command');
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    const { cluster, service, desiredCount } = command.input;
    this.sent.push({
      ...(cluster === undefined ? {} : { cluster }),
      ...(service === undefined ? {} : { service }),
      ...(desiredCount === undefined ? {} : { desiredCount }),
    });
    return Promise.resolve({});
  }
}

describe('loadRunnerLaunchConfig', () => {
  it('starts the runner as a child process locally, and must be told how in production', () => {
    expect(loadRunnerLaunchConfig({})).toEqual({ kind: 'process' });
    expect(loadRunnerLaunchConfig({ BROWSER_RUNNER_LAUNCH: 'none' })).toEqual({ kind: 'none' });
    expect(() => loadRunnerLaunchConfig({ NODE_ENV: 'production' })).toThrow(
      RunnerLaunchConfigError,
    );
    expect(() => loadRunnerLaunchConfig({ BROWSER_RUNNER_LAUNCH: 'lambda' })).toThrow(
      'BROWSER_RUNNER_LAUNCH must be one of process, ecs, none',
    );
  });

  it('names the runner service for ecs', () => {
    expect(
      loadRunnerLaunchConfig({
        BROWSER_RUNNER_LAUNCH: 'ecs',
        BROWSER_RUNNER_CLUSTER: 'listora-personal',
        BROWSER_RUNNER_SERVICE: 'runner',
        AWS_REGION: 'us-east-1',
      }),
    ).toEqual({
      kind: 'ecs',
      cluster: 'listora-personal',
      service: 'runner',
      region: 'us-east-1',
    });
  });
});

describe('EcsServiceRunnerLauncher', () => {
  it('sets the runner service to one task, and never throws', async () => {
    const ecs = new FakeEcs();
    const launcher = createRunnerLauncher(
      { kind: 'ecs', cluster: 'listora-personal', service: 'runner', region: 'us-east-1' },
      { logger: silentLogger, runnerEntry: 'unused', ecs },
    );
    expect(launcher).toBeInstanceOf(EcsServiceRunnerLauncher);
    await launcher.ensureRunning();
    await launcher.ensureRunning();
    expect(ecs.sent).toEqual([
      { cluster: 'listora-personal', service: 'runner', desiredCount: 1 },
      { cluster: 'listora-personal', service: 'runner', desiredCount: 1 },
    ]);
    ecs.failWith = new Error('throttled');
    await expect(launcher.ensureRunning()).resolves.toBeUndefined();
  });

  it('scales the service back to zero for the exiting runner', async () => {
    const ecs = new FakeEcs();
    await scaleRunnerServiceToZero({ cluster: 'listora-personal', service: 'runner' }, ecs);
    expect(ecs.sent).toEqual([{ cluster: 'listora-personal', service: 'runner', desiredCount: 0 }]);
  });
});

describe('ProcessRunnerLauncher', () => {
  let dir: string | undefined;
  let launcher: ProcessRunnerLauncher | undefined;

  afterEach(() => {
    launcher?.stop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('starts one child process at a time, and another once it exits', async () => {
    dir = mkdtempSync(join(tmpdir(), 'listora-launcher-'));
    const marker = join(dir, 'starts');
    const entry = join(dir, 'runner.ts');
    writeFileSync(
      entry,
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'x');\nsetTimeout(() => process.exit(0), 1500);\n`,
    );
    launcher = new ProcessRunnerLauncher(entry, silentLogger);
    await launcher.ensureRunning();
    await launcher.ensureRunning();
    await until(() => readStarts(marker) >= 1);
    // Still running: asking again starts no second runner.
    await launcher.ensureRunning();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(readStarts(marker)).toBe(1);
    // Once it exited, the next request starts a new one.
    await until(async () => {
      await launcher?.ensureRunning();
      return readStarts(marker) >= 2;
    });
    expect(readStarts(marker)).toBe(2);
  });
});

async function until(done: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function readStarts(path: string): number {
  try {
    return readFileSync(path, 'utf8').length;
  } catch {
    return 0;
  }
}
