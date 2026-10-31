import { isSha256Hex, type Logger } from '@listora/shared';

import { AiCallError, AiGuardError, AiProviderError } from './errors.ts';
import {
  NO_ACCOUNT_BLOCKS,
  UNLIMITED_QUOTA,
  type AccountBlocks,
  type KillSwitch,
  type QuotaCharge,
  type QuotaContext,
  type QuotaPolicy,
} from './guards.ts';
import type { ModelRegistry } from './models.ts';
import { CURRENT_PRICE_TABLE, costMicros, type PriceTable } from './prices.ts';
import type { AiProvider, ProviderRequest, ProviderResponse } from './provider.ts';
import type {
  AiImage,
  AiProviderId,
  AiThinking,
  AiTier,
  OutputSchema,
  TokenUsage,
  WebSearchOptions,
  WebSource,
} from './types.ts';
import type { UsageEventInput, UsageStore } from './usage-store.ts';

const PURPOSE = /^[a-z][a-z0-9_]*$/;

/** Who a call is for and why; every usage event carries it. */
export interface AiCallContext {
  readonly accountId: string;
  readonly userId?: string | null;
  readonly itemId?: string | null;
  /** snake_case, for example `item_analysis`. */
  readonly purpose: string;
}

export interface AiCall<T> {
  readonly context: AiCallContext;
  readonly tier: AiTier;
  readonly system: string;
  readonly prompt: string;
  /** The photo-set hash of the photos `images` were derived from (`itemPhotoSet().hash`). */
  readonly photoSetHash: string;
  readonly images: readonly AiImage[];
  readonly output: OutputSchema<T>;
  /** The reseller unit this call uses up when it succeeds; omit for calls no plan limits. */
  readonly quota?: QuotaCharge;
  /** Lets the model search the web; each search is billed and metered. */
  readonly webSearch?: WebSearchOptions;
  /** Absent: `adaptive`, thinking within the tier's effort. */
  readonly thinking?: AiThinking;
  readonly signal?: AbortSignal;
}

/** What `AiClient.checkGuards` needs to know about a call that is about to be made. */
export interface AiGuardRequest {
  readonly accountId: string;
  readonly tier: AiTier;
  readonly purpose: string;
  readonly quota?: QuotaCharge;
}

export interface AiResult<T> {
  readonly output: T;
  readonly provider: AiProviderId;
  readonly tier: AiTier;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly costMicros: number;
  readonly priceTableVersion: string;
  readonly latencyMs: number;
  readonly usageEventId: string;
  /** The pages the call's web searches returned; empty without web search. */
  readonly webSources: readonly WebSource[];
}

export interface AiClientOptions {
  readonly provider: AiProvider;
  readonly registry: ModelRegistry;
  readonly usageStore: UsageStore;
  readonly killSwitch: KillSwitch;
  /** Accounts an operator has blocked from AI; none by default. */
  readonly accountBlocks?: AccountBlocks;
  /** Per-account circuit breaker: no new call once today's (UTC) spend reaches this. */
  readonly dailyBudgetMicros: number;
  readonly quota?: QuotaPolicy;
  readonly prices?: PriceTable;
  readonly logger?: Logger;
  /** Wall clock, for the budget reset time. */
  readonly now?: () => Date;
}

/**
 * The only way the rest of Listora calls AI. For each call it:
 * 1. checks the guards, in order: global kill switch, an operator's block on the account, the
 *    account's daily dollar budget, and the plan quota. A tripped guard throws `AiGuardError` before anything is sent, and
 *    nothing billable is recorded;
 * 2. resolves the tier to its configured model and sends one provider request;
 * 3. records an `ai_usage_event` priced from the versioned price table, for a failed call
 *    too, with whatever usage the provider billed. A failure then throws `AiCallError`.
 *
 * The budget check happens before the call, so calls already in flight when the budget is
 * reached can each finish; the overshoot is bounded by their own cost.
 */
export class AiClient {
  readonly #provider: AiProvider;
  readonly #registry: ModelRegistry;
  readonly #usageStore: UsageStore;
  readonly #killSwitch: KillSwitch;
  readonly #accountBlocks: AccountBlocks;
  readonly #dailyBudgetMicros: number;
  readonly #quota: QuotaPolicy;
  readonly #prices: PriceTable;
  readonly #logger: Logger | undefined;
  readonly #now: () => Date;

  constructor(options: AiClientOptions) {
    if (!Number.isSafeInteger(options.dailyBudgetMicros) || options.dailyBudgetMicros < 0) {
      throw new RangeError('dailyBudgetMicros must be a non-negative integer');
    }
    this.#provider = options.provider;
    this.#registry = options.registry;
    this.#usageStore = options.usageStore;
    this.#killSwitch = options.killSwitch;
    this.#accountBlocks = options.accountBlocks ?? NO_ACCOUNT_BLOCKS;
    this.#dailyBudgetMicros = options.dailyBudgetMicros;
    this.#quota = options.quota ?? UNLIMITED_QUOTA;
    this.#prices = options.prices ?? CURRENT_PRICE_TABLE;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  async generate<T>(call: AiCall<T>): Promise<AiResult<T>> {
    const { context, tier } = call;
    if (!PURPOSE.test(context.purpose)) {
      throw new TypeError('AI call purpose must be snake_case, for example item_analysis');
    }
    if (!isSha256Hex(call.photoSetHash)) {
      throw new TypeError('AI call photoSetHash must be lowercase sha256 hex');
    }
    const quotaContext = this.#quotaContext({
      accountId: context.accountId,
      tier,
      purpose: context.purpose,
      ...(call.quota === undefined ? {} : { quota: call.quota }),
    });

    await this.#checkGuards(context.accountId, quotaContext);

    const settings = this.#registry[tier];
    const started = performance.now();
    const sent = await this.#send({
      model: settings.model,
      effort: settings.effort,
      system: call.system,
      prompt: call.prompt,
      photoSetHash: call.photoSetHash,
      images: call.images,
      output: call.output,
      maxOutputTokens: settings.maxOutputTokens,
      ...(call.webSearch === undefined ? {} : { webSearch: call.webSearch }),
      ...(call.thinking === undefined ? {} : { thinking: call.thinking }),
      ...(call.signal === undefined ? {} : { signal: call.signal }),
    });
    const latencyMs = Math.round(performance.now() - started);

    const usage = sent.ok ? sent.response.usage : sent.failure.usage;
    const cost = costMicros(this.#prices, settings.model, { ...usage, batch: false });
    const event: UsageEventInput = {
      accountId: context.accountId,
      userId: context.userId ?? null,
      itemId: context.itemId ?? null,
      purpose: context.purpose,
      tier,
      provider: this.#provider.id,
      model: settings.model,
      usage,
      images: call.images.length,
      batch: false,
      costMicros: cost,
      priceTableVersion: this.#prices.version,
      latencyMs,
      outcome: sent.ok ? 'succeeded' : 'failed',
      errorCode: sent.ok ? null : sent.failure.code,
    };
    let recorded: { readonly id: string };
    try {
      recorded = await this.#usageStore.record(event);
    } catch (error) {
      // The provider has billed this call; keep enough in the log to reconcile it by hand.
      this.#logger?.error(
        { err: error, usageEvent: event },
        'failed to record AI usage; the call was billed but is not metered',
      );
      throw error;
    }

    if (!sent.ok) {
      this.#logger?.warn(
        {
          accountId: context.accountId,
          purpose: context.purpose,
          tier,
          model: settings.model,
          code: sent.failure.code,
          costMicros: cost,
          usageEventId: recorded.id,
        },
        'AI call failed',
      );
      throw new AiCallError(sent.failure, {
        tier,
        model: settings.model,
        costMicros: cost,
        usageEventId: recorded.id,
      });
    }

    if (quotaContext !== undefined) await this.#quota.consume(quotaContext);
    return {
      output: sent.response.output,
      provider: this.#provider.id,
      tier,
      model: settings.model,
      usage,
      costMicros: cost,
      priceTableVersion: this.#prices.version,
      latencyMs,
      usageEventId: recorded.id,
      webSources: sent.response.webSources ?? [],
    };
  }

  /** The model the tier's calls go to. */
  modelFor(tier: AiTier): string {
    return this.#registry[tier].model;
  }

  /**
   * Runs the same guards `generate` runs first, without calling the provider or recording
   * anything, so a caller can refuse work up front (for example an API request that would
   * queue an analysis) with the reason a call would be refused. Throws `AiGuardError`. The
   * call itself checks again when it runs.
   */
  async checkGuards(request: AiGuardRequest): Promise<void> {
    await this.#checkGuards(request.accountId, this.#quotaContext(request));
  }

  #quotaContext(request: AiGuardRequest): QuotaContext | undefined {
    const { quota } = request;
    if (quota === undefined) return undefined;
    if (!Number.isSafeInteger(quota.units) || quota.units < 1) {
      throw new RangeError('AI call quota units must be a positive integer');
    }
    return {
      accountId: request.accountId,
      tier: request.tier,
      purpose: request.purpose,
      charge: quota,
    };
  }

  async #send<T>(
    request: ProviderRequest<T>,
  ): Promise<
    { ok: true; response: ProviderResponse<T> } | { ok: false; failure: AiProviderError }
  > {
    try {
      return { ok: true, response: await this.#provider.generate(request) };
    } catch (error) {
      const failure =
        error instanceof AiProviderError
          ? error
          : new AiProviderError('unknown', error instanceof Error ? error.message : String(error), {
              cause: error,
            });
      return { ok: false, failure };
    }
  }

  async #checkGuards(accountId: string, quota: QuotaContext | undefined): Promise<void> {
    if (await this.#killSwitch.isEngaged()) {
      throw new AiGuardError({ kind: 'kill_switch' });
    }
    if (await this.#accountBlocks.isBlocked(accountId)) {
      throw new AiGuardError({ kind: 'account_blocked' });
    }
    const spentMicros = await this.#usageStore.spentTodayMicros(accountId);
    if (spentMicros >= this.#dailyBudgetMicros) {
      throw new AiGuardError({
        kind: 'daily_budget',
        spentMicros,
        limitMicros: this.#dailyBudgetMicros,
        resetsAt: nextUtcMidnight(this.#now()),
      });
    }
    if (quota !== undefined) {
      const decision = await this.#quota.check(quota);
      if (!decision.allowed) {
        throw new AiGuardError({
          kind: 'quota',
          metric: quota.charge.metric,
          used: decision.used,
          limit: decision.limit,
        });
      }
    }
  }
}

function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
