import { HttpImportPhotoFetcher } from '@listora/imports';

import type { WorkerConfig } from './config.ts';

/**
 * The fetcher of marketplace listing photos (imports and sold items): from the marketplaces' own
 * image CDNs over https; plain http only from a local fake marketplace, which development
 * configures (`FAKE_*_URL`).
 */
export function importPhotoFetcher(config: WorkerConfig): HttpImportPhotoFetcher {
  const local = Object.values(config.automation.profiles).some((profile) =>
    profile.origins.some((origin) => /^http:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(origin)),
  );
  return new HttpImportPhotoFetcher({ allowLocalHttp: local });
}
