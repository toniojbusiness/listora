import type { ObjectStorage } from '@listora/storage';
import {
  InvalidSummarySettingsError,
  loadSummarySettings,
  loadToday,
  saveSummarySettings,
} from '@listora/today';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { validationFailed } from '../errors.ts';
import { coverPhotoRows } from '../items/repository.ts';

import { summarySettingsView, todayView } from './views.ts';

export interface TodayRouteDependencies extends RouteDependencies {
  /** The cards' item photo URLs. */
  storage: ObjectStorage;
  now: () => Date;
}

/**
 * `getToday`: what needs the seller, computed on every request from plain queries
 * (`loadToday` in @listora/today; docs/features/today.md). `getTodaySettings` and
 * `replaceTodaySettings`: the morning summary notification's setting.
 */
export function registerTodayRoutes(app: FastifyInstance, deps: TodayRouteDependencies): void {
  contractRoute(app, deps, 'getToday', async ({ tenant, db }) => {
    const summary = await loadToday(db, tenant.accountId, deps.now());
    const itemIds = summary.cards.flatMap((card) => ('item' in card ? [card.item.id] : []));
    const covers = await coverPhotoRows(db, tenant, [...new Set(itemIds)]);
    return { status: 200, body: todayView(summary, covers, deps.storage) };
  });

  contractRoute(app, deps, 'getTodaySettings', async ({ tenant, db }) => ({
    status: 200,
    body: summarySettingsView(await loadSummarySettings(db, tenant.accountId)),
  }));

  contractRoute(app, deps, 'replaceTodaySettings', async ({ tenant, db, body }) => {
    try {
      const saved = await saveSummarySettings(db, tenant.accountId, {
        enabled: body.enabled,
        localTime: body.time,
        timeZone: body.timeZone,
      });
      return { status: 200, body: summarySettingsView(saved) };
    } catch (error) {
      if (error instanceof InvalidSummarySettingsError) {
        throw validationFailed([
          { field: error.field === 'localTime' ? 'time' : 'timeZone', message: error.message },
        ]);
      }
      throw error;
    }
  });
}
