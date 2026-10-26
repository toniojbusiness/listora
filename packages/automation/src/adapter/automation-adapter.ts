/**
 * The automation adapter base (docs/features/automation.md, decision D1): a marketplace
 * adapter whose steps run as scripts in the seller's own browser session. The per-marketplace
 * automation adapters configure it with their scripts; a kind without a script stays assisted,
 * so each kind of operation switches to automation on its own.
 *
 * - Capabilities: kinds with a script are `automation`, verified by `automation` reads
 *   (`readListing` runs the read script in the same kind of session); the rest are the
 *   assisted adapter's. The engine never counts an automated step done without a current
 *   read-back (section 6), exactly as for an API step.
 * - `execute` maps every way a script can end onto an outcome. It never throws, and it never
 *   reports more than it knows: a step that may have changed the listing and then failed is
 *   `unknown` (a read-back decides), and only an applied script is `confirmed`.
 * - A check automation must not pass (a CAPTCHA, a bot check, a login check, a page off the
 *   marketplace), a session the marketplace rejected, and a page the script no longer
 *   understands all fall back to the assisted task for the step: the user does it, and only
 *   their confirmation finishes it. The connection then waits for the seller to relink, so
 *   nothing retries around the check.
 */
import type { Marketplace } from '@listora/db';
import {
  MARKETPLACE_NAMES,
  type AdapterContext,
  type AssistedAdapter,
  type AssistedListingPayload,
  type Excerpt,
  type Health,
  type ItemSnapshot,
  type ListingRef,
  type ListingVariant,
  type MarketplaceAdapter,
  type MarketplaceCapabilities,
  type OperationRequest,
  type Outcome,
  type RemoteListingState,
  type RemoteListings,
  type RemoteOrder,
  type ValidationIssue,
  type WriteOperationKind,
} from '@listora/marketplaces';
import { assertNever, type Logger } from '@listora/shared';

import type { AutomatedMarketplace, AutomationProfile } from '../profiles.ts';
import { challengeMessage } from '../safety/challenges.ts';
import type { ScriptFailure, ScriptResult, StepRunner } from '../runner/types.ts';
import type { AutomationSessions, SessionRequest, SessionRun } from './sessions.ts';

/** What a write script reports when it ran to its end. */
export type WriteResult =
  /** The marketplace took the change; the engine still reads it back to verify. */
  | { type: 'applied'; externalListingId?: string; revision?: number }
  /** The marketplace refused it (a validation message on its form): retrying cannot help. */
  | { type: 'rejected'; code: string; message: string; fixHint?: string };

export type WriteScript<P extends AssistedListingPayload> = (
  op: OperationRequest<P>,
  step: StepRunner,
) => Promise<WriteResult>;

export interface AutomationScripts<P extends AssistedListingPayload> {
  create?: WriteScript<P>;
  revise?: WriteScript<P>;
  price?: WriteScript<P>;
  end?: WriteScript<P>;
  relist?: WriteScript<P>;
  markSold?: WriteScript<P>;
  /**
   * Reads the listing (by its id, else by the seller's SKU). Must say `authoritative` only for
   * the marketplace's own "removed" answer for that id. Only reads: no step may mutate.
   */
  read: (ref: ListingRef, step: StepRunner) => Promise<RemoteListingState>;
  /** Opens a page only a logged-in seller sees, to show the session works. Only reads. */
  health: (step: StepRunner) => Promise<void>;
  /** The seller's orders sold at or after `since`, for sale checks. Only reads. */
  orders?: (since: Date | null, step: StepRunner) => Promise<RemoteOrder[]>;
  /** The seller's listings, for imports and drift checks. Only reads. */
  listings?: (step: StepRunner) => Promise<RemoteListings>;
}

const SCRIPT_FOR_KIND = {
  create: 'create',
  revise: 'revise',
  price: 'price',
  end: 'end',
  relist: 'relist',
  mark_sold: 'markSold',
} as const satisfies Record<WriteOperationKind, keyof AutomationScripts<AssistedListingPayload>>;

export interface AutomationAdapterOptions<P extends AssistedListingPayload> {
  marketplace: AutomatedMarketplace;
  profile: AutomationProfile;
  sessions: AutomationSessions;
  /** Serves the kinds without a script, and every step that has to fall back to the user. */
  assisted: AssistedAdapter;
  scripts: AutomationScripts<P>;
  /** `revision` when the read script returns the listing's revision, else `none`. */
  readFreshness: 'revision' | 'none';
  /** The marketplace's payload; it extends the assisted one, which a fallback task copies from. */
  buildPayload?: (item: ItemSnapshot, variant: ListingVariant) => P;
  /** The marketplace's own rules, on top of the assisted ones. */
  validate?: (payload: P) => ValidationIssue[];
  capabilities?: Partial<
    Pick<
      MarketplaceCapabilities,
      'importListings' | 'taxonomy' | 'pricingData' | 'externalSkuReusable' | 'limits'
    >
  >;
  logger: Logger;
}

export class AutomationAdapter<
  P extends AssistedListingPayload = AssistedListingPayload,
> implements MarketplaceAdapter<P> {
  readonly id: Marketplace;
  readonly #name: string;
  readonly #options: AutomationAdapterOptions<P>;
  readonly #capabilities: MarketplaceCapabilities;
  readonly #log: Logger;

  constructor(options: AutomationAdapterOptions<P>) {
    if (
      options.assisted.id !== options.marketplace ||
      options.profile.marketplace !== options.marketplace
    ) {
      throw new Error('the assisted adapter and the profile must be for the same marketplace');
    }
    this.id = options.marketplace;
    this.#name = MARKETPLACE_NAMES[options.marketplace];
    this.#options = options;
    this.#log = options.logger.child({ marketplace: options.marketplace, adapter: 'automation' });
    const assisted = options.assisted.capabilities();
    const { scripts } = options;
    this.#capabilities = {
      ...assisted,
      ...options.capabilities,
      connect: 'session',
      create: scripts.create === undefined ? assisted.create : 'automation',
      updatePrice: scripts.price === undefined ? assisted.updatePrice : 'automation',
      updateDetails: scripts.revise === undefined ? assisted.updateDetails : 'automation',
      delist: scripts.end === undefined ? assisted.delist : 'automation',
      relist: scripts.relist === undefined ? assisted.relist : 'automation',
      markSold: scripts.markSold === undefined ? assisted.markSold : 'automation',
      verifyRead: 'automation',
      readFreshness: options.readFreshness,
      saleDetection:
        options.scripts.orders === undefined ? ['email', 'manual'] : ['poll', 'email', 'manual'],
      imageTransport: 'upload',
    };
  }

  capabilities(): MarketplaceCapabilities {
    return this.#capabilities;
  }

  buildPayload(item: ItemSnapshot, variant: ListingVariant): P {
    return (
      this.#options.buildPayload?.(item, variant) ??
      (this.#options.assisted.buildPayload(item, variant) as P)
    );
  }

  validate(payload: P): ValidationIssue[] {
    return [
      ...this.#options.assisted.validate(payload),
      ...(this.#options.validate?.(payload) ?? []),
    ];
  }

  async execute(op: OperationRequest<P>, ctx: AdapterContext): Promise<Outcome> {
    const script = this.#options.scripts[SCRIPT_FOR_KIND[op.kind]];
    if (script === undefined) return this.#assistedTask(op);
    const connection = ctx.connection;
    if (connection === null) return this.#assistedTask(op, { automation: 'no_connection' });
    let run: SessionRun<WriteResult>;
    try {
      run = await this.#options.sessions.use(
        this.#request(connection, 'operation', op.operationId, op.kind),
        (session, signal) => session.run(op.kind, (step) => script(op, step), signal),
        ctx.signal,
      );
    } catch (error) {
      // Listora's own failure (the database, the vault) somewhere around the run: the script
      // may have acted, so only a read-back can tell.
      this.#log.error({ err: error, operationId: op.operationId }, 'automation session failed');
      return {
        type: 'unknown',
        code: 'automation_error',
        message: `Listora lost track of the change on ${this.#name} and is checking it.`,
      };
    }
    return this.#writeOutcome(op, run);
  }

  async readListing(ref: ListingRef, ctx: AdapterContext): Promise<RemoteListingState> {
    const connection = this.#connection(ctx);
    const run = await this.#options.sessions.use(
      this.#request(connection, 'operation', ctx.operationId ?? null, 'read listing'),
      (session, signal) =>
        session.read('read listing', (step) => this.#options.scripts.read(ref, step), signal),
      ctx.signal,
    );
    return this.#readValue(run, 'read the listing');
  }

  async healthCheck(ctx: AdapterContext): Promise<Health> {
    const connection = ctx.connection;
    if (connection === null) return { status: 'ok' };
    let run: SessionRun<void>;
    try {
      run = await this.#options.sessions.use(
        this.#request(connection, 'health', null, 'health check'),
        (session, signal) =>
          session.read('health check', (step) => this.#options.scripts.health(step), signal),
        ctx.signal,
      );
    } catch {
      return this.#degraded('automation_error');
    }
    switch (run.type) {
      case 'no_session':
        return {
          status: 'reauth_required',
          code: 'session_missing',
          message: `Log in to ${this.#name} again in the app to keep automating.`,
        };
      case 'rate_limited':
      case 'busy':
        return this.#degraded(run.type);
      case 'ran':
        if (run.result.ok) return { status: 'ok' };
        if (run.result.failure.kind === 'challenge') {
          return {
            status: 'reauth_required',
            code: run.result.failure.challenge,
            message: challengeMessage(run.result.failure.challenge, this.#name),
          };
        }
        return this.#degraded(
          run.result.failure.kind === 'error' ? run.result.failure.code : 'timeout',
        );
      default:
        return assertNever(run, 'session run');
    }
  }

  async listOrdersSince(since: Date | null, ctx: AdapterContext): Promise<RemoteOrder[]> {
    const orders = this.#options.scripts.orders;
    if (orders === undefined) throw new Error(`Listora doesn't read ${this.#name} orders`);
    const connection = this.#connection(ctx);
    const run = await this.#options.sessions.use(
      this.#request(connection, 'sale_check', null, 'sold orders'),
      (session, signal) => session.read('sold orders', (step) => orders(since, step), signal),
      ctx.signal,
    );
    return this.#readValue(run, 'check sales');
  }

  async listListings(ctx: AdapterContext): Promise<RemoteListings> {
    const listings = this.#options.scripts.listings;
    if (listings === undefined) throw new Error(`Listora doesn't list ${this.#name} listings`);
    const connection = this.#connection(ctx);
    const run = await this.#options.sessions.use(
      this.#request(connection, 'operation', null, 'list listings'),
      (session, signal) => session.read('list listings', (step) => listings(step), signal),
      ctx.signal,
    );
    return this.#readValue(run, 'list your listings');
  }

  #writeOutcome(op: OperationRequest<P>, run: SessionRun<WriteResult>): Promise<Outcome> | Outcome {
    switch (run.type) {
      case 'no_session':
        return this.#assistedTask(op, { automation: 'no_session' });
      case 'rate_limited':
        return {
          type: 'transient',
          code: 'automation_paced',
          message: `Listora is pacing its ${this.#name} actions and will try again shortly.`,
          retryAfterMs: run.retryAfterMs,
        };
      case 'busy':
        return {
          type: 'transient',
          code: 'automation_busy',
          message: `Listora is already working in your ${this.#name} account and will try again shortly.`,
          retryAfterMs: run.retryAfterMs,
        };
      case 'ran':
        return this.#scriptOutcome(op, run.result);
      default:
        return assertNever(run, 'session run');
    }
  }

  #scriptOutcome(
    op: OperationRequest<P>,
    result: ScriptResult<WriteResult>,
  ): Promise<Outcome> | Outcome {
    const excerpt = scriptExcerpt(op.kind, result);
    if (result.ok) {
      const { value } = result;
      switch (value.type) {
        case 'applied':
          return {
            type: 'confirmed',
            ...(value.externalListingId === undefined
              ? {}
              : { externalListingId: value.externalListingId }),
            ...(value.revision === undefined ? {} : { revision: value.revision }),
            excerpt,
          };
        case 'rejected':
          return {
            type: 'rejected',
            code: value.code,
            message: value.message.includes(this.#name)
              ? value.message
              : `${this.#name}: ${value.message}`,
            ...(value.fixHint === undefined ? {} : { fixHint: value.fixHint }),
            excerpt,
          };
        default:
          return assertNever(value, 'write result');
      }
    }
    const { failure, mutated } = result;
    const unknown = (): Outcome => ({
      type: 'unknown',
      code: failureCode(failure),
      message: `Listora isn't sure the change reached ${this.#name} and is checking the listing.`,
      excerpt,
    });
    const transient = (retryAfterMs?: number | null): Outcome => ({
      type: 'transient',
      code: failureCode(failure),
      message: `${this.#name} didn't respond as expected. Listora will try again.`,
      ...(retryAfterMs === null || retryAfterMs === undefined ? {} : { retryAfterMs }),
      excerpt,
    });
    switch (failure.kind) {
      case 'challenge':
        // The connection now waits for a relink; the user does this step.
        return this.#assistedTask(op, { ...excerpt, automation: 'challenge' });
      case 'timeout':
        return mutated ? unknown() : transient();
      case 'error':
        switch (failure.code) {
          case 'rate_limited':
            return transient(failure.retryAfterMs);
          case 'server_error':
            // A 5xx can hide an applied change; the engine reads back before sending again.
            return transient();
          case 'element_missing':
            if (mutated) return unknown();
            this.#log.error(
              { kind: op.kind, step: failure.step, operationId: op.operationId },
              'an automation script no longer understands the page; falling back to the user',
            );
            return this.#assistedTask(op, { ...excerpt, automation: 'page_changed' });
          case 'unreachable':
          case 'aborted':
          case 'browser_unavailable':
          case 'script_error':
            return mutated ? unknown() : transient();
          default:
            return assertNever(failure.code, 'script error code');
        }
      default:
        return assertNever(failure, 'script failure');
    }
  }

  #readValue<T>(run: SessionRun<T>, what: string): T {
    switch (run.type) {
      case 'no_session':
        throw new Error(`Listora can't ${what} on ${this.#name} until you log in again.`);
      case 'rate_limited':
      case 'busy':
        throw new Error(`Listora will ${what} on ${this.#name} again shortly.`);
      case 'ran':
        if (run.result.ok) return run.result.value;
        throw new Error(
          `Listora couldn't ${what} on ${this.#name} (${failureCode(run.result.failure)}).`,
        );
      default:
        return assertNever(run, 'session run');
    }
  }

  /** The user's task for the step, from the assisted adapter, with why automation stepped back. */
  async #assistedTask(op: OperationRequest<P>, why?: Excerpt): Promise<Outcome> {
    const outcome = await this.#options.assisted.execute(op);
    return why === undefined ? outcome : { ...outcome, excerpt: { ...outcome.excerpt, ...why } };
  }

  #request(
    connection: NonNullable<AdapterContext['connection']>,
    purpose: SessionRequest['purpose'],
    operationIdOrNull: string | null,
    script: string,
  ): SessionRequest {
    return {
      connection,
      purpose,
      operationId: purpose === 'operation' ? operationIdOrNull : null,
      script,
    };
  }

  #connection(ctx: AdapterContext): NonNullable<AdapterContext['connection']> {
    if (ctx.connection === null)
      throw new Error(`Listora has no ${this.#name} session to read with.`);
    return ctx.connection;
  }

  #degraded(code: string): Health {
    return {
      status: 'degraded',
      code,
      message:
        code === 'browser_unavailable'
          ? `Listora's browser didn't start, so it couldn't check your ${this.#name} sign-in. The problem is on Listora's side, not ${this.#name}'s.`
          : `Listora couldn't check your ${this.#name} sign-in just now.`,
    };
  }
}

function failureCode(failure: ScriptFailure): string {
  switch (failure.kind) {
    case 'challenge':
      return failure.challenge;
    case 'timeout':
      return 'step_timeout';
    case 'error':
      return failure.code;
    default:
      return assertNever(failure, 'script failure');
  }
}

/** The run, for the operation's history: step names and how it ended, never page content. */
function scriptExcerpt(kind: WriteOperationKind, result: ScriptResult<WriteResult>): Excerpt {
  return {
    script: kind,
    steps: result.steps,
    mutated: result.mutated,
    ...(result.ok
      ? { result: result.value.type }
      : {
          failure: {
            kind: result.failure.kind,
            step: result.failure.step,
            code: failureCode(result.failure),
            screenshot: result.failure.screenshotKey !== null,
          },
        }),
  };
}
