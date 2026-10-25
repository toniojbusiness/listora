import type { WorkerFeature } from '../features.ts';

/**
 * The daily marketplace connection health check (`connection_health`), when the worker has a
 * token vault to open tokens with (connections.ts).
 */
export const feature: WorkerFeature = {
  jobs: ({ connections }) => ({ scheduledTasks: connections.scheduledTasks }),
};
