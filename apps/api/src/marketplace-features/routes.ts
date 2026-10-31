import { MARKETPLACES, type DbExecutor } from '@listora/db';
import {
  appFeaturesOn,
  featuresOn,
  isAppFeatureInTesting,
  isFeatureInTesting,
  loadFeatureGate,
  SELLER_FEATURES,
  type FeatureGate,
} from '@listora/marketplaces';
import type { FastifyInstance } from 'fastify';

import { writeAudit } from '../audit.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { notFound } from '../errors.ts';

import { mayUseTestMode } from './test-mode.ts';

/**
 * Each marketplace's features that passed a live end-to-end test
 * (docs/features/verified-features.md): the app shows only these, and the server runs only
 * their checks. The same for every account but the deployment owner's in Test mode
 * (docs/features/test-mode.md), which gets every built feature, the untested ones named in
 * `testing`.
 */
export function registerMarketplaceFeatureRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
): void {
  contractRoute(app, deps, 'listMarketplaceFeatures', async ({ tenant, db }) => {
    const allowed = await mayUseTestMode(db, tenant, deps.signUp);
    let gate = await loadFeatureGate(db, tenant.accountId);
    // Left on for an account that may no longer use it (SIGN_UP_OWNER_EMAIL changed): turned off
    // here, which the app reads at each launch, so every gate is back to the verified features.
    if (gate.testMode && !allowed) {
      await saveTestMode(db, tenant.accountId, false);
      gate = SELLER_FEATURES;
    }
    return { status: 200, body: featureList(gate, allowed) };
  });

  contractRoute(app, deps, 'setTestMode', async ({ tenant, db, body }) => {
    if (!(await mayUseTestMode(db, tenant, deps.signUp))) throw notFound('Test mode');
    await saveTestMode(db, tenant.accountId, body.on);
    await writeAudit(db, tenant, { action: 'account.test_mode_changed', changes: { on: body.on } });
    return { status: 200, body: featureList({ testMode: body.on }, true) };
  });
}

async function saveTestMode(db: DbExecutor, accountId: string, on: boolean): Promise<void> {
  await db.updateTable('account').set({ test_mode: on }).where('id', '=', accountId).execute();
}

function featureList(gate: FeatureGate, allowed: boolean) {
  const app = appFeaturesOn(gate);
  const appTesting = app.filter((feature) => isAppFeatureInTesting(feature, gate));
  return {
    data: MARKETPLACES.map((marketplace) => {
      const features = featuresOn(marketplace, gate);
      const testing = features.filter((feature) => isFeatureInTesting(marketplace, feature, gate));
      return { marketplace, features, ...(testing.length === 0 ? {} : { testing }) };
    }),
    app: { features: app, ...(appTesting.length === 0 ? {} : { testing: appTesting }) },
    ...(allowed ? { testMode: { on: gate.testMode } } : {}),
  };
}
