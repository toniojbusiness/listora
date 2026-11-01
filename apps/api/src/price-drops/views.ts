import type { PlannedPriceDrop, PriceDropDefaults, PriceDropRule } from '@listora/api-contract';
import type { DropDefaults, DropRule, ListingDropPlan } from '@listora/price-drops';

export function ruleView(
  rule: DropRule,
  item: { sku: string; title: string | null } | undefined,
  liveListings: number,
): PriceDropRule {
  return {
    id: rule.id,
    scope: rule.scope,
    ...(rule.itemId === null ? {} : { itemId: rule.itemId }),
    ...(item === undefined ? {} : { sku: item.sku }),
    ...(item?.title === undefined || item.title === null ? {} : { title: item.title }),
    ...(rule.brand === null ? {} : { brand: rule.brand }),
    percent: rule.percent,
    afterDays: rule.afterDays,
    floor: { amountCents: rule.floorCents, currency: rule.currency },
    enabled: rule.enabled,
    armedAt: rule.armedAt.toISOString(),
    liveListings,
  };
}

export function plannedDropView({ fact, rule, plan }: ListingDropPlan): PlannedPriceDrop {
  return {
    listingId: fact.listingId,
    itemId: fact.itemId,
    sku: fact.sku,
    ...(fact.title === null ? {} : { title: fact.title }),
    marketplace: fact.marketplace,
    ruleId: rule.id,
    price: { amountCents: fact.priceCents ?? 0, currency: fact.currency },
    state: plan.state,
    ...(plan.state === 'scheduled'
      ? {
          at: plan.at.toISOString(),
          nextPrice: { amountCents: plan.priceCents, currency: fact.currency },
        }
      : {}),
  };
}

export function defaultsView(
  defaults: DropDefaults,
  itemFloorCents: number | null,
): PriceDropDefaults {
  return {
    percent: defaults.percent,
    afterDays: defaults.afterDays,
    ...(itemFloorCents === null ? {} : { floor: { amountCents: itemFloorCents, currency: 'USD' } }),
    ...(defaults.basis === undefined
      ? {}
      : {
          basis: {
            sales: defaults.basis.sales,
            medianDays: defaults.basis.medianDays,
            ...(defaults.basis.brand === undefined ? {} : { brand: defaults.basis.brand }),
          },
        }),
  };
}
