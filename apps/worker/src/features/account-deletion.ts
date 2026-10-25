import {
  ACCOUNT_DELETION_TASK,
  accountDeletionTask,
  AwsCognitoUserAdmin,
  noMarketplaceAccessRevocation,
} from '@listora/accounts';

import type { WorkerFeature } from '../features.ts';

/**
 * Finishes account deletions (`account_deletion`): deletes the person at the identity provider
 * and revokes marketplace grants, retrying until done.
 */
export const feature: WorkerFeature = {
  jobs: ({ config, db, connections, logger }) => ({
    tasks: {
      [ACCOUNT_DELETION_TASK]: accountDeletionTask({
        db,
        cognito: config.cognitoUserPool && new AwsCognitoUserAdmin(config.cognitoUserPool),
        marketplaceAccess: connections.revoker ?? noMarketplaceAccessRevocation,
        logger,
      }),
    },
  }),
};
