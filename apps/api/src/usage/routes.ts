import { PostgresQuotaPolicy } from '@listora/ai';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';

export interface UsageRouteDependencies extends RouteDependencies {
  now: () => Date;
}

/**
 * `getUsage`: the account's plan quota use in the current period, read from the counters the
 * AI guards enforce (`PostgresQuotaPolicy`), so the app shows the same numbers that decide a
 * `402 quota_exceeded`.
 */
export function registerUsageRoutes(app: FastifyInstance, deps: UsageRouteDependencies): void {
  contractRoute(app, deps, 'getUsage', async ({ tenant, db }) => {
    const usage = await new PostgresQuotaPolicy(db, { now: deps.now }).usage(tenant.accountId);
    return {
      status: 200,
      body: {
        periodStart: usage.period.start,
        periodEnd: usage.period.end,
        quotas: usage.quotas.map((quota) => ({
          metric: quota.metric,
          used: quota.used,
          ...(quota.limit === null ? {} : { limit: quota.limit }),
        })),
      },
    };
  });
}
