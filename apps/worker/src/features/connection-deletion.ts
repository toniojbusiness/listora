import { CONNECTION_DELETION_TASK, connectionDeletionTask } from '@listora/connections';

import type { WorkerFeature } from '../features.ts';

/**
 * Finishes connection deletions (`connection_deletion`, docs/features/privacy.md): asks the
 * marketplace to revoke the grant, deletes the connection's stored screenshots, and records the
 * checked deletion, retrying until done.
 */
export const feature: WorkerFeature = {
  jobs: ({ db, connections, storage, logger }) => ({
    tasks: {
      [CONNECTION_DELETION_TASK]: connectionDeletionTask({
        db,
        revoker: connections.revoker,
        storage,
        logger,
      }),
    },
  }),
};
