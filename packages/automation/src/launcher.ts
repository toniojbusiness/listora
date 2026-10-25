/**
 * Starting the browser runner on demand (decision D1). The runner holds no task while idle: the
 * worker starts it when automated work is due and it exits after a short idle spell
 * (docs/costs.md prices it per hour of use).
 *
 * - `ecs`: the runner is an ECS service whose desired count is 0 while idle; the worker sets
 *   it to 1, and the runner sets it back to 0 as it exits. Setting it is idempotent, so a
 *   second request while one task starts changes nothing.
 * - `process`: locally the worker starts the runner as a child process.
 * - `none`: something else runs it (tests, or `npm run dev:runner` by hand).
 *
 * A live runner holds a Postgres session named `listora-browser-runner:<id>`, which the
 * operating system closes when it dies, so whether one is running needs no bookkeeping.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { sql } from 'kysely';
import pg from 'pg';

import type { Db } from '@listora/db';
import { assertNever, type Logger } from '@listora/shared';

export const RUNNER_SESSION_PREFIX = 'listora-browser-runner:';

export interface RunnerLauncher {
  readonly kind: RunnerLaunchConfig['kind'];
  /** Makes sure a runner is starting or running. Never throws; failures are logged. */
  ensureRunning(): Promise<void>;
}

export type RunnerLaunchConfig =
  | { readonly kind: 'process' }
  | {
      readonly kind: 'ecs';
      readonly cluster: string;
      readonly service: string;
      readonly region: string;
    }
  | { readonly kind: 'none' };

export class RunnerLaunchConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid browser runner configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'RunnerLaunchConfigError';
    this.issues = issues;
  }
}

const LAUNCH_KINDS = ['process', 'ecs', 'none'] as const;

/**
 * `BROWSER_RUNNER_LAUNCH` (default `process` locally; production sets it), and for `ecs` the
 * runner service's `BROWSER_RUNNER_CLUSTER`, `BROWSER_RUNNER_SERVICE`, and `AWS_REGION`.
 */
export function loadRunnerLaunchConfig(env: NodeJS.ProcessEnv = process.env): RunnerLaunchConfig {
  const raw = env['BROWSER_RUNNER_LAUNCH'] ?? '';
  const kind = LAUNCH_KINDS.find((candidate) => candidate === raw);
  if (raw === '' && env['NODE_ENV'] !== 'production') return { kind: 'process' };
  if (kind === undefined) {
    throw new RunnerLaunchConfigError([
      `BROWSER_RUNNER_LAUNCH must be one of ${LAUNCH_KINDS.join(', ')}`,
    ]);
  }
  if (kind !== 'ecs') return { kind };
  return { kind, ...loadRunnerServiceConfig(env) };
}

/** The ECS service of the browser runner, which the runner also scales down when it exits. */
export function loadRunnerServiceConfig(env: NodeJS.ProcessEnv = process.env): {
  cluster: string;
  service: string;
  region: string;
} {
  const issues: string[] = [];
  const cluster = env['BROWSER_RUNNER_CLUSTER'] ?? '';
  const service = env['BROWSER_RUNNER_SERVICE'] ?? '';
  const region = env['AWS_REGION'] ?? '';
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(cluster)) issues.push('BROWSER_RUNNER_CLUSTER is required');
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(service)) issues.push('BROWSER_RUNNER_SERVICE is required');
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) issues.push('AWS_REGION must be an AWS region');
  if (issues.length > 0) throw new RunnerLaunchConfigError(issues);
  return { cluster, service, region };
}

export interface LauncherDependencies {
  logger: Logger;
  /** The runner's entry point, for the `process` launcher. */
  runnerEntry: string;
  /** For the `ecs` launcher; tests pass a fake. */
  ecs?: Pick<ECSClient, 'send'>;
}

export function createRunnerLauncher(
  config: RunnerLaunchConfig,
  deps: LauncherDependencies,
): RunnerLauncher {
  switch (config.kind) {
    case 'process':
      return new ProcessRunnerLauncher(deps.runnerEntry, deps.logger);
    case 'ecs':
      return new EcsServiceRunnerLauncher({
        cluster: config.cluster,
        service: config.service,
        client: deps.ecs ?? new ECSClient({ region: config.region }),
        logger: deps.logger,
      });
    case 'none':
      return { kind: 'none', ensureRunning: () => Promise.resolve() };
    default:
      return assertNever(config, 'runner launch');
  }
}

/** Starts the runner as a child process of this one, with the same environment. */
export class ProcessRunnerLauncher implements RunnerLauncher {
  readonly kind = 'process' as const;
  readonly #entry: string;
  readonly #log: Logger;
  #child: ChildProcess | null = null;

  constructor(entry: string, logger: Logger) {
    this.#entry = entry;
    this.#log = logger.child({ component: 'runner-launcher' });
  }

  ensureRunning(): Promise<void> {
    if (this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null) {
      return Promise.resolve();
    }
    const child = spawn(process.execPath, [this.#entry], { stdio: 'inherit', env: process.env });
    this.#child = child;
    child.on('error', (error) => {
      this.#log.error({ err: error }, 'the browser runner could not start');
    });
    child.on('exit', (code, signal) => {
      this.#log.info({ code, signal }, 'the browser runner exited');
      if (this.#child === child) this.#child = null;
    });
    this.#log.info({ pid: child.pid }, 'started the browser runner');
    return Promise.resolve();
  }

  /** Stops a runner this process started (the worker shutting down). */
  stop(): void {
    this.#child?.kill('SIGTERM');
  }
}

export interface EcsLauncherOptions {
  cluster: string;
  service: string;
  client: Pick<ECSClient, 'send'>;
  logger: Logger;
}

/** Sets the runner service's desired count to 1. */
export class EcsServiceRunnerLauncher implements RunnerLauncher {
  readonly kind = 'ecs' as const;
  readonly #options: EcsLauncherOptions;

  constructor(options: EcsLauncherOptions) {
    this.#options = options;
  }

  async ensureRunning(): Promise<void> {
    const { cluster, service, client, logger } = this.#options;
    try {
      await client.send(new UpdateServiceCommand({ cluster, service, desiredCount: 1 }));
      logger.info({ service }, 'asked ECS to start the browser runner');
    } catch (error) {
      logger.error({ err: error, service }, 'ECS did not start the browser runner');
    }
  }
}

/** The runner's own scale-down as it exits (ECS: desired count 0). */
export async function scaleRunnerServiceToZero(
  config: { cluster: string; service: string },
  client: Pick<ECSClient, 'send'>,
): Promise<void> {
  await client.send(
    new UpdateServiceCommand({ cluster: config.cluster, service: config.service, desiredCount: 0 }),
  );
}

/** Whether a browser runner is alive (its session is open). */
export async function browserRunnerAlive(db: Db): Promise<boolean> {
  const { rows } = await sql<{ alive: boolean }>`
    select exists (
      select 1 from pg_stat_activity where application_name like ${`${RUNNER_SESSION_PREFIX}%`}
    ) as alive
  `.execute(db);
  return rows[0]?.alive === true;
}

/**
 * The session that shows this runner is alive, held for its whole life. Losing it means
 * workers may start another runner, so the runner stops (`onLost`).
 */
export async function openRunnerPresence(
  connectionString: string,
  onLost: (error: Error) => void,
): Promise<{ close(): Promise<void> }> {
  let closing = false;
  const client = new pg.Client({
    connectionString,
    application_name: `${RUNNER_SESSION_PREFIX}${String(process.pid)}-${Math.random().toString(36).slice(2, 10)}`,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
  });
  client.on('error', (error) => {
    if (!closing) onLost(error);
  });
  client.on('end', () => {
    if (!closing) onLost(new Error('the browser runner presence session ended'));
  });
  await client.connect();
  return {
    async close() {
      closing = true;
      await client.end();
    },
  };
}
