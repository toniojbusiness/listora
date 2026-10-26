import {
  ACCOUNT_DELETION_TASK,
  accountDeletionTask,
  AwsCognitoUserAdmin,
  noMarketplaceAccessRevocation,
} from '@listora/accounts';

import type { WorkerFeature } from '../features.ts';

/**
 * Finishes account deletions (`account_deletion`): deletes the person at the identity provider,
 * revokes marketplace grants, and deletes the account's stored objects, retrying until done,
 * then records the checked deletion.
 */
export const feature: WorkerFeature = {
  jobs: ({ config, db, connections, storage, logger }) => ({
    tasks: {
      [ACCOUNT_DELETION_TASK]: accountDeletionTask({
        db,
        cognito: config.cognitoUserPool && new AwsCognitoUserAdmin(config.cognitoUserPool),
        marketplaceAccess: connections.revoker ?? noMarketplaceAccessRevocation,
        storage,
        logger,
      }),
    },
  }),
};
