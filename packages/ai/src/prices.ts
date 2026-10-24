/**
 * Versioned AI price tables. Every metered call records the version it was priced with, so a
 * price change never rewrites history: add a new table with a new version and make it current.
 *
 * Prices are integer micro-dollars (1,000,000 = $1) per million tokens. $1 per million tokens
 * is exactly one micro-dollar per token, so a published "$0.10 / MTok" is written 100_000 here
 * and all cost math stays in integers.
 */

export interface TokenPrices {
  readonly input: number;
  readonly output: number;
  /** 5-minute cache writes; the providers only ever request the 5-minute TTL. */
  readonly cacheWrite: number;
  readonly cacheRead: number;
}

export interface ModelPrices extends TokenPrices {
  /**
   * Higher prices for a request whose prompt (input plus cache read and cache write tokens)
   * is longer than `aboveInputTokens`. The whole request pays them, not only the excess.
   */
  readonly longContext?: { readonly aboveInputTokens: number; readonly prices: TokenPrices };
}

export interface PriceTable {
  readonly version: string;
  readonly source: string;
  /** Per search, in micro-dollars. */
  readonly webSearchMicros: number;
  /** Batch API discount on every token price (cache prices included). */
  readonly batchDiscountPercent: number;
  readonly models: Readonly<Record<string, ModelPrices>>;
}

/**
 * Anthropic list prices, verified on 2026-10-24 against the live pricing page,
 * https://platform.claude.com/docs/en/about-claude/pricing.md. Cache reads are 0.1x the base
 * input price on Haiku 5.5 and 0.05x on Sonnet 5.5 and Opus 5.5; 5-minute cache writes are
 * 1.25x on every model.
 */
const PRICES_2026_10_24: PriceTable = {
  version: '2026-10-24',
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  webSearchMicros: 10_000,
  batchDiscountPercent: 50,
  models: {
    'claude-haiku-5-5': {
      input: 100_000,
      output: 500_000,
      cacheWrite: 125_000,
      cacheRead: 10_000,
      longContext: {
        aboveInputTokens: 100_000,
        prices: { input: 500_000, output: 2_500_000, cacheWrite: 625_000, cacheRead: 50_000 },
      },
    },
    'claude-sonnet-5-5': {
      input: 2_000_000,
      output: 10_000_000,
      cacheWrite: 2_500_000,
      cacheRead: 100_000,
    },
    'claude-opus-5-5': {
      input: 4_000_000,
      output: 20_000_000,
      cacheWrite: 5_000_000,
      cacheRead: 200_000,
    },
  },
};

/** Every table ever used, oldest first. Never edit or remove one that has been released. */
export const PRICE_TABLES: readonly PriceTable[] = [PRICES_2026_10_24];

export const CURRENT_PRICE_TABLE: PriceTable = PRICES_2026_10_24;

export class UnpricedModelError extends Error {
  readonly model: string;
  readonly priceTableVersion: string;

  constructor(model: string, priceTableVersion: string) {
    super(`model ${model} has no price in price table ${priceTableVersion}`);
    this.name = 'UnpricedModelError';
    this.model = model;
    this.priceTableVersion = priceTableVersion;
  }
}

/** The table with this version, for recomputing the cost of an earlier event. */
export function priceTable(version: string): PriceTable {
  const table = PRICE_TABLES.find((candidate) => candidate.version === version);
  if (table === undefined) throw new RangeError(`unknown price table version ${version}`);
  return table;
}

export function isPriced(table: PriceTable, model: string): boolean {
  return Object.hasOwn(table.models, model);
}

/** What a provider bills for one call. */
export interface BillableUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly webSearches: number;
  readonly batch?: boolean;
}

/**
 * The cost of one call in micro-dollars, rounded up to the next whole micro-dollar so that
 * metering never under-counts. Rounding happens once, on the total.
 */
export function costMicros(table: PriceTable, model: string, usage: BillableUsage): number {
  const modelPrices = table.models[model];
  if (modelPrices === undefined || !isPriced(table, model)) {
    throw new UnpricedModelError(model, table.version);
  }
  for (const [field, value] of Object.entries(usage)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`usage ${field} must be a non-negative integer, got ${String(value)}`);
    }
  }

  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const long = modelPrices.longContext;
  const prices =
    long !== undefined && promptTokens > long.aboveInputTokens ? long.prices : modelPrices;

  // Micro-dollars times tokens per million tokens; exact in integers for any real request.
  let tokenAmount =
    usage.inputTokens * prices.input +
    usage.outputTokens * prices.output +
    usage.cacheReadTokens * prices.cacheRead +
    usage.cacheWriteTokens * prices.cacheWrite;
  let divisor = 1_000_000;
  if (usage.batch === true) {
    tokenAmount *= 100 - table.batchDiscountPercent;
    divisor *= 100;
  }
  if (!Number.isSafeInteger(tokenAmount)) {
    throw new RangeError('usage is too large to price exactly');
  }
  return Math.ceil(tokenAmount / divisor) + usage.webSearches * table.webSearchMicros;
}
