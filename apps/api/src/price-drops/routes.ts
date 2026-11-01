import type { DbExecutor } from '@listora/db';
import { loadFeatureGate, type FeatureGate } from '@listora/marketplaces';
import {
  createDropRule,
  deleteDropRule,
  DropRuleExistsError,
  DropRuleNotFoundError,
  InvalidDropRuleError,
  listDropRules,
  loadDropDefaults,
  loadDropFacts,
  planDrops,
  priceDropMarketplaces,
  ruleFor,
  updateDropRule,
  type DropRule,
} from '@listora/price-drops';
import type { Money } from '@listora/shared';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import type { Tenant } from '../tenancy.ts';

import { defaultsView, plannedDropView, ruleView } from './views.ts';

/**
 * Smart price drops (docs/features/price-drops.md): `listPriceDrops`, `getPriceDropDefaults`,
 * `createPriceDropRule`, `replacePriceDropRule`, `deletePriceDropRule`. None of them changes a
 * price: the worker's schedule runs each drop when it is due, as a price change confirmed by a
 * read-back. Every route is `404` while price drops are hidden from the account (not passed
 * live, and not in Test mode), so for anyone else they do not exist.
 */
export function registerPriceDropRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  contractRoute(app, deps, 'listPriceDrops', async ({ tenant, db, query }) => {
    const gate = await assertPriceDropsOn(db, tenant);
    const now = new Date();
    const rules = await listDropRules(db, tenant.accountId);
    const plans = planDrops(await loadDropFacts(db, tenant.accountId), rules, gate, now);
    let shown = rules;
    if (query.itemId !== undefined) {
      const rule = ruleFor(rules, await itemOf(db, tenant, query.itemId));
      shown = rule === undefined ? [] : [rule];
    }
    const items = await itemsOf(db, tenant, shown);
    return {
      status: 200,
      body: {
        rules: shown.map((rule) =>
          ruleView(
            rule,
            items.get(rule.itemId ?? ''),
            plans.filter((plan) => plan.rule.id === rule.id).length,
          ),
        ),
        planned: plans
          .filter((plan) => query.itemId === undefined || plan.fact.itemId === query.itemId)
          .map(plannedDropView),
      },
    };
  });

  contractRoute(app, deps, 'getPriceDropDefaults', async ({ tenant, db, query }) => {
    await assertPriceDropsOn(db, tenant);
    const item = query.itemId === undefined ? undefined : await itemOf(db, tenant, query.itemId);
    const brand = item?.brand ?? query.brand ?? null;
    const defaults = await loadDropDefaults(db, tenant.accountId, brand);
    return { status: 200, body: defaultsView(defaults, item?.floorCents ?? null) };
  });

  contractRoute(app, deps, 'createPriceDropRule', async ({ tenant, db, body }) => {
    await assertPriceDropsOn(db, tenant);
    if ((body.itemId === undefined) === (body.brand === undefined)) {
      throw validationFailed(
        [{ field: 'itemId', message: 'Name one item or one brand.' }],
        'A rule is for one item or one brand.',
      );
    }
    const terms = termsOf(body);
    try {
      const rule = await createDropRule(
        db,
        tenant.accountId,
        body.itemId === undefined
          ? { scope: 'brand', brand: body.brand ?? '' }
          : { scope: 'item', itemId: body.itemId },
        terms,
      );
      const items = await itemsOf(db, tenant, [rule]);
      return { status: 201, body: ruleView(rule, items.get(rule.itemId ?? ''), 0) };
    } catch (error) {
      throw refused(error);
    }
  });

  contractRoute(app, deps, 'replacePriceDropRule', async ({ tenant, db, params, body }) => {
    const gate = await assertPriceDropsOn(db, tenant);
    try {
      const rule = await updateDropRule(db, tenant.accountId, params.ruleId, {
        ...termsOf(body),
        enabled: body.enabled,
      });
      const facts = await loadDropFacts(db, tenant.accountId);
      const live = planDrops(facts, [rule], gate, new Date()).length;
      const items = await itemsOf(db, tenant, [rule]);
      return { status: 200, body: ruleView(rule, items.get(rule.itemId ?? ''), live) };
    } catch (error) {
      throw refused(error);
    }
  });

  contractRoute(app, deps, 'deletePriceDropRule', async ({ tenant, db, params }) => {
    await assertPriceDropsOn(db, tenant);
    try {
      await deleteDropRule(db, tenant.accountId, params.ruleId);
    } catch (error) {
      throw refused(error);
    }
    return { status: 204 };
  });
}

/**
 * Refuses an account price drops are not on for (on no marketplace: not passed live, and not in
 * Test mode); answers its gate otherwise.
 */
async function assertPriceDropsOn(db: DbExecutor, tenant: Tenant): Promise<FeatureGate> {
  const gate = await loadFeatureGate(db, tenant.accountId);
  if (priceDropMarketplaces(gate).length === 0) throw notFound('Price drops');
  return gate;
}

function termsOf(body: { percent: number; afterDays: number; floor: Money }) {
  return { percent: body.percent, afterDays: body.afterDays, floorCents: body.floor.amountCents };
}

async function itemOf(db: DbExecutor, tenant: Tenant, itemId: string) {
  const row = await db
    .selectFrom('inventory_item')
    .select(['id', 'brand', 'floor_price_cents'])
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', itemId)
    .executeTakeFirst();
  if (row === undefined) throw notFound('Item');
  return { id: row.id, brand: row.brand, floorCents: row.floor_price_cents };
}

/** The SKU and title of the item rules' items. */
async function itemsOf(db: DbExecutor, tenant: Tenant, rules: readonly DropRule[]) {
  const ids = rules.flatMap((rule) => (rule.itemId === null ? [] : [rule.itemId]));
  if (ids.length === 0) return new Map<string, { sku: string; title: string | null }>();
  const rows = await db
    .selectFrom('inventory_item')
    .select(['id', 'sku', 'title'])
    .where('account_id', '=', tenant.accountId)
    .where('id', 'in', ids)
    .execute();
  return new Map(rows.map((row) => [row.id, { sku: row.sku, title: row.title }]));
}

function refused(error: unknown): unknown {
  if (error instanceof InvalidDropRuleError) {
    return validationFailed([{ field: error.field, message: error.message }], error.message);
  }
  if (error instanceof DropRuleNotFoundError) {
    return notFound(error.message.includes('item') ? 'Item' : 'Price drop rule');
  }
  if (error instanceof DropRuleExistsError) {
    return new ApiError('already_exists', 'This already has a price drop rule. Change that one.');
  }
  return error;
}
