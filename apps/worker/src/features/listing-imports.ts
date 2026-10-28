import { isListingImportJobPayload, LISTING_IMPORT_APPLY_TASK } from '@listora/automation';
import { applyListingImport } from '@listora/imports';

import type { WorkerFeature } from '../features.ts';
import { importPhotoFetcher } from '../import-photos.ts';

/**
 * Listing imports (`listing_import_apply`, docs/features/imports.md): after every page an
 * import reads, turns the listings read into items already listed there, adds them to the items
 * they are, or asks the seller, and finishes the import once every listing is settled. Photos
 * come from the marketplaces' own image CDNs; plain http only from a local fake marketplace,
 * which development configures (`FAKE_*_URL`).
 */
export const feature: WorkerFeature = {
  jobs: ({ config, db, storage, logger }) => ({
    tasks: {
      [LISTING_IMPORT_APPLY_TASK]: async (payload) => {
        if (!isListingImportJobPayload(payload)) {
          logger.error(
            { task: LISTING_IMPORT_APPLY_TASK },
            'job with an invalid payload; dropping it',
          );
          return;
        }
        await applyListingImport(
          { db, storage, photos: importPhotoFetcher(config), logger },
          payload,
        );
      },
    },
  }),
};
