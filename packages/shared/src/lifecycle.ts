import type { Logger } from 'pino';

export interface ShutdownOptions {
  logger: Logger;
  /** Releases resources (close servers, drain jobs, end pools). */
  shutdown: () => Promise<void>;
  /** Force exit if shutdown hangs. */
  timeoutMs?: number;
  signals?: readonly NodeJS.Signals[];
}

/**
 * Runs `shutdown` once on the first SIGTERM or SIGINT, then exits: 0 on a clean shutdown,
 * 1 if shutdown throws or exceeds the timeout. ECS sends SIGTERM before stopping a task.
 */
export function handleShutdownSignals(options: ShutdownOptions): void {
  const { logger, shutdown, timeoutMs = 10_000, signals = ['SIGTERM', 'SIGINT'] } = options;
  let shuttingDown = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const timer = setTimeout(() => {
      logger.error({ timeoutMs }, 'shutdown timed out');
      process.exit(1);
    }, timeoutMs);
    timer.unref();

    shutdown().then(
      () => {
        logger.info('shutdown complete');
        process.exit(0);
      },
      (error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  };

  for (const signal of signals) process.once(signal, onSignal);
}
