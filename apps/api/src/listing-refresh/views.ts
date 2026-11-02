import type {
  ItemRefresh,
  ListingRefresh as ListingRefreshView,
  ListingRefreshSettings,
} from '@listora/api-contract';
import type { DbExecutor } from '@listora/db';
import {
  formatClock,
  listingRefresh,
  loadRefreshFacts,
  loadRefreshSettings,
  quietWindowOf,
  type Cadence,
  type ListingRefresh,
  type RefreshSettings,
} from '@listora/listing-refresh';

import type { Tenant } from '../tenancy.ts';

export function refreshSettingsView(settings: RefreshSettings): ListingRefreshSettings {
  return {
    cadence: settings.cadence,
    relistToRefresh: settings.relistToRefresh,
    ...(settings.customHours === null ? {} : { customHours: settings.customHours }),
    ...(settings.quietStart === null || settings.quietEnd === null
      ? {}
      : {
          quietWindow: {
            start: formatClock(settings.quietStart),
            end: formatClock(settings.quietEnd),
          },
        }),
    ...(settings.timeZone === null ? {} : { timeZone: settings.timeZone }),
  };
}

export function itemRefreshView(item: Cadence | null, account: Cadence): ItemRefresh {
  return {
    ...(item === null ? {} : { cadence: item.cadence }),
    ...(item?.customHours === null || item === null ? {} : { customHours: item.customHours }),
    accountCadence: account.cadence,
    ...(account.customHours === null ? {} : { accountCustomHours: account.customHours }),
  };
}

export function listingRefreshView(refresh: ListingRefresh): ListingRefreshView {
  return {
    state: refresh.state,
    ...(refresh.state === 'scheduled' ? { nextAt: refresh.nextAt.toISOString() } : {}),
    ...(refresh.lastAt === null ? {} : { lastAt: refresh.lastAt.toISOString() }),
  };
}

/** The live listings' refreshes, by listing id (docs/features/listing-refresh.md). */
export async function listingRefreshes(
  db: DbExecutor,
  tenant: Tenant,
  listingIds: readonly string[],
  now: Date,
): Promise<Map<string, ListingRefresh>> {
  if (listingIds.length === 0) return new Map();
  const [settings, facts] = await Promise.all([
    loadRefreshSettings(db, tenant.accountId),
    loadRefreshFacts(db, tenant.accountId, { listingIds }),
  ]);
  const window = quietWindowOf(settings);
  return new Map(
    facts.map((fact) => [fact.listingId, listingRefresh(fact, settings, window, now)]),
  );
}
