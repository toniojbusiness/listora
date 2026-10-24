import { createLogger, handleShutdownSignals } from '@listora/shared';

import { loadWorkerConfig } from './config.ts';

const config = loadWorkerConfig();
const logger = createLogger({ service: 'worker', level: config.logLevel });

// Placeholder process lifecycle. T-06 replaces the idle timer with the Graphile Worker runner
// that executes marketplace operations; until then the worker only starts and stops cleanly.
const idle = setInterval(() => undefined, 60_000);

handleShutdownSignals({
  logger,
  shutdown: () => {
    clearInterval(idle);
    return Promise.resolve();
  },
});

logger.info('worker ready');
