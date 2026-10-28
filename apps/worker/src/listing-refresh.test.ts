import { describe, expect, it } from 'vitest';

import {
  createAutomationAdapters,
  HttpPhotoSource,
  loadAutomationSettings,
  NoBrowserSessions,
} from '@listora/automation';
import { MARKETPLACES } from '@listora/db';
import { canRefresh, isReadOnlyConnection } from '@listora/listing-refresh';
import { createMarketplaceAdapters, operationMode } from '@listora/marketplaces';
import { createLogger } from '@listora/shared';

describe('which listings Listora refreshes', () => {
  it("agrees with the adapters' own refresh: under a linked session, never assisted or by API", () => {
    const adapters = createMarketplaceAdapters({
      fakeMarketplaceUrl: undefined,
      ebay: undefined,
      depop: undefined,
      automation: createAutomationAdapters({
        // The real sites' adapters (nothing is contacted: there is no browser).
        settings: loadAutomationSettings({}),
        sessions: NoBrowserSessions,
        photos: new HttpPhotoSource(),
        logger: createLogger({ service: 'test', level: 'silent' }),
      }),
    });
    const connections = [
      { id: 'c', mode: 'automation', status: 'connected' },
      { id: 'c', mode: 'automation', status: 'reauth_required' },
      { id: 'c', mode: 'assisted', status: 'connected' },
      { id: 'c', mode: 'api', status: 'connected' },
    ] as const;
    for (const marketplace of MARKETPLACES) {
      for (const connection of [...connections, null]) {
        const capabilities = adapters.capabilities(marketplace, connection);
        const mode =
          capabilities === undefined ? 'unsupported' : operationMode(capabilities, 'refresh');
        // A read-only connection is never refreshed, whatever its adapter can do.
        const writable = mode === 'automation' && !isReadOnlyConnection({ marketplace });
        expect(writable, `${marketplace} ${JSON.stringify(connection)}`).toBe(
          canRefresh({ marketplace, connection }),
        );
        expect(mode, "a refresh is never the seller's").not.toBe('assisted');
      }
    }
  });
});
