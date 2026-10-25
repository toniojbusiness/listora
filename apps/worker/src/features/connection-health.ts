import type { WorkerFeature } from '../features.ts';

/**
 * The daily marketplace connection health check (`connection_health`) and the check a seller
 * asks for (`connection_health_check`), when the worker has a token vault to open tokens with
 * (connections.ts).
 */
export const feature: WorkerFeature = {
  jobs: ({ connections }) => ({
    tasks: connections.tasks,
    scheduledTasks: connections.scheduledTasks,
  }),
};
