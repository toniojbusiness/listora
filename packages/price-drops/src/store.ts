/**
 * The seller's price drop rules (`price_drop_rule`, docs/features/price-drops.md): one per item
 * and one per brand. An item's own rule wins over its brand's, also when it is off (so one item
 * can be left out of a brand's rule). Making, changing, or turning on a rule re-arms it: none of
 * its drops runs until `DROP_NOTICE_HOURS` later, so each planned drop is seen first.
 */
import type { DbExecutor, PriceDropRuleScope } from '@listora/db';
import type { CurrencyCode } from '@listora/shared';
import { brandKey } from '@listora/sourcing';
import { sql } from 'kysely';

import { assertDropTerms, InvalidDropRuleError, type DropTerms } from './rules.ts';

/** A rule as it is stored. */
export interface DropRule extends DropTerms {
  id: string;
  scope: PriceDropRuleScope;
  /** With `item`. */
  itemId: string | null;
  /** With `brand`: as the seller wrote it, and the key items' brands match by. */
  brand: string | null;
  brandKey: string | null;
  currency: CurrencyCode;
  enabled: boolean;
  /** When it last took effect (made, changed, or turned on). */
  armedAt: Date;
  createdAt: Date;
}

/** What a new rule is for: one item, or every item of a brand. */
export type DropRuleTarget = { scope: 'item'; itemId: string } | { scope: 'brand'; brand: string };

/** The item has no such item, or the rule no such rule, in this account. */
export class DropRuleNotFoundError extends Error {
  constructor(what: 'item' | 'rule') {
    super(`price drop ${what} not found`);
    this.name = 'DropRuleNotFoundError';
  }
}

/** The item or brand has a rule already: change that one instead. */
export class DropRuleExistsError extends Error {
  readonly ruleId: string;

  constructor(ruleId: string) {
    super('this item or brand has a price drop rule already');
    this.name = 'DropRuleExistsError';
    this.ruleId = ruleId;
  }
}

const MAX_BRAND_LENGTH = 200;

interface RuleRow {
  id: string;
  scope: PriceDropRuleScope;
  item_id: string | null;
  brand: string | null;
  brand_key: string | null;
  percent: number;
  after_days: number;
  floor_cents: number;
  currency: CurrencyCode;
  enabled: boolean;
  armed_at: Date;
  created_at: Date;
}

function ruleOf(row: RuleRow): DropRule {
  return {
    id: row.id,
    scope: row.scope,
    itemId: row.item_id,
    brand: row.brand,
    brandKey: row.brand_key,
    percent: row.percent,
    afterDays: row.after_days,
    floorCents: row.floor_cents,
    currency: row.currency,
    enabled: row.enabled,
    armedAt: row.armed_at,
    createdAt: row.created_at,
  };
}

const RULE_COLUMNS = [
  'id',
  'scope',
  'item_id',
  'brand',
  'brand_key',
  'percent',
  'after_days',
  'floor_cents',
  'currency',
  'enabled',
  'armed_at',
  'created_at',
] as const;

/** The account's rules, item rules first, then brands by name. */
export async function listDropRules(db: DbExecutor, accountId: string): Promise<DropRule[]> {
  const rows = await db
    .selectFrom('price_drop_rule')
    .select(RULE_COLUMNS)
    .where('account_id', '=', accountId)
    .orderBy('scope', 'desc')
    .orderBy(sql`lower(brand)`)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map(ruleOf);
}

export async function findDropRule(
  db: DbExecutor,
  accountId: string,
  ruleId: string,
): Promise<DropRule | undefined> {
  const row = await db
    .selectFrom('price_drop_rule')
    .select(RULE_COLUMNS)
    .where('account_id', '=', accountId)
    .where('id', '=', ruleId)
    .executeTakeFirst();
  return row === undefined ? undefined : ruleOf(row);
}

/**
 * Makes a rule, on (armed now). Refuses terms out of range (`InvalidDropRuleError`), an item not
 * in the account or a brand with no letters, and a second rule for the same item or brand
 * (`DropRuleExistsError`).
 */
export async function createDropRule(
  db: DbExecutor,
  accountId: string,
  target: DropRuleTarget,
  terms: DropTerms,
): Promise<DropRule> {
  assertDropTerms(terms);
  const where =
    target.scope === 'item' ? await itemTarget(db, accountId, target.itemId) : brandTarget(target);
  const existing = await db
    .selectFrom('price_drop_rule')
    .select('id')
    .where('account_id', '=', accountId)
    .where('scope', '=', target.scope)
    .where((eb) =>
      target.scope === 'item'
        ? eb('item_id', '=', target.itemId)
        : eb('brand_key', '=', where.brand_key ?? ''),
    )
    .executeTakeFirst();
  if (existing !== undefined) throw new DropRuleExistsError(existing.id);
  const row = await db
    .insertInto('price_drop_rule')
    .values({
      account_id: accountId,
      scope: target.scope,
      ...where,
      percent: terms.percent,
      after_days: terms.afterDays,
      floor_cents: terms.floorCents,
    })
    .returning(RULE_COLUMNS)
    .executeTakeFirstOrThrow();
  return ruleOf(row);
}

async function itemTarget(db: DbExecutor, accountId: string, itemId: string) {
  const item = await db
    .selectFrom('inventory_item')
    .select('id')
    .where('account_id', '=', accountId)
    .where('id', '=', itemId)
    .executeTakeFirst();
  if (item === undefined) throw new DropRuleNotFoundError('item');
  return { item_id: itemId, brand: null, brand_key: null };
}

function brandTarget(target: { brand: string }) {
  const brand = target.brand.trim().replace(/\s+/g, ' ');
  const key = brandKey(brand);
  if (key === undefined || brand.length > MAX_BRAND_LENGTH) {
    throw new InvalidDropRuleError('brand', 'Enter the brand as it is on the tag.');
  }
  return { item_id: null, brand, brand_key: key };
}

/**
 * Replaces a rule's terms and its switch. A change of terms, or turning it on, re-arms it, so its
 * next drops wait out the notice again; turning it off leaves the time alone.
 */
export async function updateDropRule(
  db: DbExecutor,
  accountId: string,
  ruleId: string,
  change: DropTerms & { enabled: boolean },
): Promise<DropRule> {
  assertDropTerms(change);
  const current = await findDropRule(db, accountId, ruleId);
  if (current === undefined) throw new DropRuleNotFoundError('rule');
  const termsChanged =
    current.percent !== change.percent ||
    current.afterDays !== change.afterDays ||
    current.floorCents !== change.floorCents;
  const rearm = change.enabled && (termsChanged || !current.enabled);
  const row = await db
    .updateTable('price_drop_rule')
    .set({
      percent: change.percent,
      after_days: change.afterDays,
      floor_cents: change.floorCents,
      enabled: change.enabled,
      ...(rearm ? { armed_at: sql<Date>`now()` } : {}),
    })
    .where('account_id', '=', accountId)
    .where('id', '=', ruleId)
    .returning(RULE_COLUMNS)
    .executeTakeFirst();
  if (row === undefined) throw new DropRuleNotFoundError('rule');
  return ruleOf(row);
}

/**
 * Deletes a rule. Drops it already queued still run (each is a price change of its own); the
 * operations keep their history without it.
 */
export async function deleteDropRule(
  db: DbExecutor,
  accountId: string,
  ruleId: string,
): Promise<void> {
  const deleted = await db
    .deleteFrom('price_drop_rule')
    .where('account_id', '=', accountId)
    .where('id', '=', ruleId)
    .executeTakeFirst();
  if (deleted.numDeletedRows === 0n) throw new DropRuleNotFoundError('rule');
}

/**
 * The rule that applies to an item: its own (on or off), else its brand's, else none. An item
 * rule that is off means "not this item", so the brand's does not apply to it either.
 */
export function ruleFor(
  rules: readonly DropRule[],
  item: { id: string; brand: string | null },
): DropRule | undefined {
  const own = rules.find((rule) => rule.scope === 'item' && rule.itemId === item.id);
  if (own !== undefined) return own;
  const key = brandKey(item.brand);
  if (key === undefined) return undefined;
  return rules.find((rule) => rule.scope === 'brand' && rule.brandKey === key);
}
