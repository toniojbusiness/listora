import type { components } from '@listora/api-contract';
import {
  InvalidRefreshSettingsError,
  itemCadence,
  loadRefreshSettings,
  parseClock,
  saveItemRefresh,
  saveRefreshSettings,
  type Cadence,
} from '@listora/listing-refresh';
import type { DbExecutor } from '@listora/db';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { notFound, validationFailed } from '../errors.ts';
import type { Tenant } from '../tenancy.ts';

import { itemRefreshView, refreshSettingsView } from './views.ts';

type QuietWindow = components['schemas']['QuietWindow'];

/**
 * `getListingRefreshSettings` and `replaceListingRefreshSettings`: how often the account's live
 * listings are refreshed, and the quiet window. `getItemRefresh` and `replaceItemRefresh`: an
 * item's own cadence over the account's (docs/features/listing-refresh.md). None of them changes
 * a listing: the worker's schedule refreshes each listing when it is due.
 */
export function registerListingRefreshRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  contractRoute(app, deps, 'getListingRefreshSettings', async ({ tenant, db }) => ({
    status: 200,
    body: refreshSettingsView(await loadRefreshSettings(db, tenant.accountId)),
  }));

  contractRoute(app, deps, 'replaceListingRefreshSettings', async ({ tenant, db, body }) => {
    onlyWithCustom(body.cadence, body.customHours);
    const window = quietWindow(body.quietWindow);
    try {
      const saved = await saveRefreshSettings(db, tenant.accountId, {
        cadence: body.cadence,
        customHours: body.customHours ?? null,
        quietStart: window?.start ?? null,
        quietEnd: window?.end ?? null,
        timeZone: body.timeZone,
      });
      return { status: 200, body: refreshSettingsView(saved) };
    } catch (error) {
      throw invalid(error);
    }
  });

  contractRoute(app, deps, 'getItemRefresh', async ({ tenant, db, params }) => {
    const item = await itemRefreshRow(db, tenant, params.itemId);
    const account = await loadRefreshSettings(db, tenant.accountId);
    return { status: 200, body: itemRefreshView(itemCadence(item), account) };
  });

  contractRoute(app, deps, 'replaceItemRefresh', async ({ tenant, db, params, body }) => {
    const cadence: Cadence | null =
      body.cadence === undefined
        ? null
        : { cadence: body.cadence, customHours: body.customHours ?? null };
    onlyWithCustom(body.cadence, body.customHours);
    try {
      if (!(await saveItemRefresh(db, tenant.accountId, params.itemId, cadence)))
        throw notFound('Item');
    } catch (error) {
      throw invalid(error);
    }
    const account = await loadRefreshSettings(db, tenant.accountId);
    return { status: 200, body: itemRefreshView(cadence, account) };
  });
}

async function itemRefreshRow(db: DbExecutor, tenant: Tenant, itemId: string) {
  const row = await db
    .selectFrom('inventory_item')
    .select(['refresh_cadence', 'refresh_custom_hours'])
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', itemId)
    .executeTakeFirst();
  if (row === undefined) throw notFound('Item');
  return row;
}

/** Hours belong to a custom cadence only. */
function onlyWithCustom(cadence: string | undefined, customHours: number | undefined): void {
  if (customHours !== undefined && cadence !== 'custom') {
    throw validationFailed([
      { field: 'customHours', message: 'Custom hours go with a custom cadence.' },
    ]);
  }
}

function quietWindow(window: QuietWindow | undefined): { start: number; end: number } | null {
  if (window === undefined) return null;
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start === null || end === null) {
    throw validationFailed([{ field: 'quietWindow', message: 'Pick times like 22:00.' }]);
  }
  return { start, end };
}

function invalid(error: unknown): unknown {
  if (error instanceof InvalidRefreshSettingsError) {
    return validationFailed([{ field: error.field, message: error.message }]);
  }
  return error;
}
