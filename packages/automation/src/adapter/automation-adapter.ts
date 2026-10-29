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
  type ConnectionRef,
  type Excerpt,
  type Health,
  type ItemSnapshot,
  type LabelReadRequest,
  type ListingRef,
  type ListingVariant,
  type MarketplaceAdapter,
  type MarketplaceCapabilities,
  type OfferAnswerOutcome,
  type OfferAnswerRequest,
  type OfferRef,
  type OperationRequest,
  type Outcome,
  type RemoteOffer,
  type RemoteOfferState,
  type ListingsPage,
  type RemoteListingState,
  type RemoteOrder,
  type RemoteOrderLabel,
  type ValidationIssue,
  type WriteOperationKind,
} from '@listora/marketplaces';
import { READ_ONLY_ERROR, readOnlyMessage } from '@listora/operations';
import { assertNever, type Logger } from '@listora/shared';

import type { AutomatedMarketplace, AutomationProfile } from '../profiles.ts';
import { challengeMessage } from '../safety/challenges.ts';
import type { ScriptFailure, ScriptResult, StepRunner } from '../runner/types.ts';
import {
  isWriteCall,
  runScriptCall,
  type AutomationScripts,
  type OfferAnswerResult,
  type ScriptCall,
  type ScriptSet,
  type WriteResult,
  type WriteScriptName,
} from './script-call.ts';
import type { AutomationSessions, SessionRequest, SessionRun } from './sessions.ts';

export type { AutomationScripts, WriteResult, WriteScript } from './script-call.ts';

/**
 * A read through the seller's session (their orders, their listings) that did not get its
 * answer: `code` says why (`no_session`, `automation_paced`, `automation_busy`, or how the
 * script stopped, such as `element_missing`), `step` names the step it stopped at, and `detail`
 * is the script's own sanitized words for why (no page text, nothing typed), for the owner only.
 */
export class AutomationReadError extends Error {
  readonly code: string;
  readonly step: string | null;
  readonly detail: string | null;

  constructor(code: string, step: string | null, message: string, detail: string | null = null) {
    super(message);
    this.name = 'AutomationReadError';
    this.code = code;
    this.step = step;
    this.detail = detail;
  }
}

const SCRIPT_FOR_KIND = {
  create: 'create',
  revise: 'revise',
  price: 'price',
  end: 'end',
  relist: 'relist',
  mark_sold: 'markSold',
  refresh: 'refresh',
} as const satisfies Record<WriteOperationKind, WriteScriptName>;

export interface AutomationAdapterOptions<P extends AssistedListingPayload> {
  marketplace: AutomatedMarketplace;
  profile: AutomationProfile;
  sessions: AutomationSessions;
  /** Serves the kinds without a script, and every step that has to fall back to the user. */
  assisted: AssistedAdapter;
  scripts: AutomationScripts<P>;
  /**
   * Which script set `scripts` is and the site it drives, so a call can be run by another host
   * (the phone) from the same definitions.
   */
  scriptSet: ScriptSet;
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
      // Never assisted: a refresh the seller had to do every few days would be a chore.
      refresh: scripts.refresh === undefined ? 'none' : 'automation',
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
      run = await this.#use<WriteResult>(
        connection,
        'operation',
        op.operationId,
        op.kind,
        { script: SCRIPT_FOR_KIND[op.kind], op, ...expectedSeller(connection) },
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
    const run = await this.#use<RemoteListingState>(
      connection,
      'operation',
      ctx.operationId ?? null,
      'read listing',
      { script: 'read', ref },
      ctx.signal,
    );
    return this.#readValue(run, 'read the listing');
  }

  async healthCheck(ctx: AdapterContext): Promise<Health> {
    const connection = ctx.connection;
    if (connection === null) return { status: 'ok' };
    let run: SessionRun<string | null | undefined>;
    try {
      run = await this.#use<string | null | undefined>(
        connection,
        'health',
        null,
        'health check',
        { script: 'health' },
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
      // Only a write is refused on a read-only connection (`read_only`); a health check never is.
      case 'rate_limited':
      case 'busy':
      case 'read_only':
        return this.#degraded(run.type);
      case 'ran':
        if (run.result.ok) {
          // A runtime older than the seller's read returns nothing: the seller stays unknown.
          const sellerId = run.result.value;
          return typeof sellerId === 'string' ? { status: 'ok', sellerId } : { status: 'ok' };
        }
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
    if (this.#options.scripts.orders === undefined) {
      throw new Error(`Listora doesn't read ${this.#name} orders`);
    }
    const connection = this.#connection(ctx);
    const run = await this.#use<RemoteOrder[]>(
      connection,
      'sale_check',
      null,
      'sold orders',
      { script: 'orders', since: since === null ? null : since.toISOString() },
      ctx.signal,
    );
    return this.#readValue(run, 'check sales');
  }

  async readOrderLabels(
    orders: readonly LabelReadRequest[],
    ctx: AdapterContext,
  ): Promise<RemoteOrderLabel[]> {
    if (this.#options.scripts.labels === undefined) {
      throw new Error(`Listora doesn't read ${this.#name} order labels`);
    }
    const connection = this.#connection(ctx);
    const run = await this.#use<RemoteOrderLabel[]>(
      connection,
      'label_read',
      null,
      'order labels',
      { script: 'labels', orders: orders.map((order) => ({ ...order })) },
      ctx.signal,
    );
    return this.#readValue(run, 'read your shipping labels');
  }

  async listOffers(ctx: AdapterContext): Promise<RemoteOffer[]> {
    if (this.#options.scripts.offers === undefined) {
      throw new Error(`Listora doesn't read ${this.#name} offers`);
    }
    const run = await this.#use<RemoteOffer[]>(
      this.#connection(ctx),
      'offer_check',
      null,
      'offers',
      { script: 'offers' },
      ctx.signal,
    );
    return this.#readValue(run, 'read your offers');
  }

  async readOffer(ref: OfferRef, ctx: AdapterContext): Promise<RemoteOfferState> {
    if (this.#options.scripts.offer === undefined) {
      throw new Error(`Listora doesn't read ${this.#name} offers`);
    }
    const run = await this.#use<RemoteOfferState>(
      this.#connection(ctx),
      'offer_response',
      null,
      'read offer',
      { script: 'offer', ref: { ...ref } },
      ctx.signal,
    );
    return this.#readValue(run, 'read the offer');
  }

  async answerOffer(request: OfferAnswerRequest, ctx: AdapterContext): Promise<OfferAnswerOutcome> {
    if (this.#options.scripts.answerOffer === undefined || ctx.connection === null) {
      return {
        type: 'needs_seller',
        code: 'unsupported',
        message: `Answer this offer in ${this.#name}.`,
      };
    }
    let run: SessionRun<OfferAnswerResult>;
    try {
      run = await this.#use<OfferAnswerResult>(
        ctx.connection,
        'offer_response',
        null,
        'answer offer',
        {
          script: 'answerOffer',
          request: { ...request, offer: { ...request.offer } },
          ...expectedSeller(ctx.connection),
        },
        ctx.signal,
      );
    } catch (error) {
      this.#log.error({ err: error, responseId: request.responseId }, 'automation session failed');
      return {
        type: 'unknown',
        code: 'automation_error',
        message: `Listora lost track of your answer on ${this.#name} and is checking the offer.`,
      };
    }
    return offerAnswerOutcome(run, this.#name);
  }

  async listListings(
    cursor: string | null,
    ctx: AdapterContext,
    held: readonly string[] = [],
  ): Promise<ListingsPage> {
    if (this.#options.scripts.listings === undefined) {
      throw new Error(`Listora doesn't list ${this.#name} listings`);
    }
    const connection = this.#connection(ctx);
    const run = await this.#use<ListingsPage>(
      connection,
      'import',
      null,
      'list listings',
      // Only when there are any, so a call without them is the call it always was.
      held.length === 0
        ? { script: 'listings', cursor }
        : { script: 'listings', cursor, held: [...held] },
      ctx.signal,
    );
    return this.#readValue(run, 'read your listings');
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
      case 'read_only':
        return this.#readOnly();
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
          case 'stopped_for_check':
            return mutated
              ? unknown()
              : {
                  type: 'transient',
                  code: failure.code,
                  message: `${this.#name} wants you to complete a check on your iPhone. Open Listora there to finish it.`,
                  excerpt,
                };
          case 'unreachable':
          case 'aborted':
          case 'browser_unavailable':
          case 'script_error':
            return mutated ? unknown() : transient();
          case 'read_only':
            // The phone runtime refused the write before any step ran.
            return { ...this.#readOnly(), excerpt };
          default:
            return assertNever(failure.code, 'script error code');
        }
      default:
        return assertNever(failure, 'script failure');
    }
  }

  /** A change refused because the connection is read only: nothing was sent. */
  #readOnly(): Outcome {
    return { type: 'rejected', code: READ_ONLY_ERROR, message: readOnlyMessage(this.id) };
  }

  #readValue<T>(run: SessionRun<T>, what: string): T {
    switch (run.type) {
      case 'no_session':
        throw new AutomationReadError(
          'no_session',
          null,
          `Listora can't ${what} on ${this.#name} until you log in again.`,
        );
      case 'rate_limited':
      case 'busy':
        throw new AutomationReadError(
          run.type === 'busy' ? 'automation_busy' : 'automation_paced',
          null,
          `Listora will ${what} on ${this.#name} again shortly.`,
        );
      case 'read_only':
        // Only a write is refused on a read-only connection; a read never is.
        throw new AutomationReadError('read_only', null, readOnlyMessage(this.id));
      case 'ran':
        if (run.result.ok) return run.result.value;
        throw new AutomationReadError(
          failureCode(run.result.failure),
          run.result.failure.step,
          `Listora couldn't ${what} on ${this.#name} (${failureCode(run.result.failure)}).`,
          failureDetail(run.result.failure),
        );
      default:
        return assertNever(run, 'session run');
    }
  }

  /**
   * The user's task for the step, from the assisted adapter, with why automation stepped back.
   * A refresh has no task: it fails, visibly and with a Retry, so the seller is never asked to
   * do Listora's scheduled work, and the schedule tries again later.
   */
  async #assistedTask(op: OperationRequest<P>, why?: Excerpt): Promise<Outcome> {
    if (op.kind === 'refresh') {
      return {
        type: 'rejected',
        code: 'refresh_stopped',
        message: `Listora couldn't refresh this listing on ${this.#name} this time.`,
        fixHint: `Listora tries again on its next refresh, or you can retry now.`,
        ...(why === undefined ? {} : { excerpt: why }),
      };
    }
    const outcome = await this.#options.assisted.execute(op);
    return why === undefined ? outcome : { ...outcome, excerpt: { ...outcome.excerpt, ...why } };
  }

  /**
   * Runs one script call in the connection's session: a write call as a run, every other as a
   * read. The request carries the call as data, so a host other than this process (the phone)
   * can run the same script.
   */
  #use<T>(
    connection: NonNullable<AdapterContext['connection']>,
    purpose: SessionRequest['purpose'],
    operationIdOrNull: string | null,
    name: string,
    call: ScriptCall<P>,
    signal: AbortSignal,
  ): Promise<SessionRun<T>> {
    const request: SessionRequest = {
      connection,
      purpose,
      operationId: purpose === 'operation' ? operationIdOrNull : null,
      script: name,
      scriptSet: this.#options.scriptSet,
      call: call,
    };
    const script = (step: StepRunner): Promise<T> =>
      runScriptCall(this.#options.scripts, call, step) as Promise<T>;
    return this.#options.sessions.use(
      request,
      (session, sessionSignal) =>
        isWriteCall(call as ScriptCall)
          ? session.run(name, script, sessionSignal)
          : session.read(name, script, sessionSignal),
      signal,
    );
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
      message: degradedMessage(code, this.#name),
    };
  }
}

/** How an offer answer's run ended (docs/features/offers.md): `sent` never claims more. */
export function offerAnswerOutcome(
  run: SessionRun<OfferAnswerResult>,
  name: string,
): OfferAnswerOutcome {
  switch (run.type) {
    case 'no_session':
      return {
        type: 'needs_seller',
        code: 'no_session',
        message: `Link ${name} again in Listora, or answer this offer in ${name}.`,
      };
    case 'rate_limited':
    case 'busy':
      return {
        type: 'not_sent',
        code: run.type === 'busy' ? 'automation_busy' : 'automation_paced',
        message: `Listora is pacing its ${name} actions and will send your answer shortly.`,
        retryAfterMs: run.retryAfterMs,
      };
    case 'read_only':
      return { type: 'needs_seller', code: 'read_only', message: readOnlyOfferMessage(name) };
    case 'ran':
      break;
    default:
      return assertNever(run, 'session run');
  }
  const { result } = run;
  if (result.ok) {
    return result.value.type === 'applied'
      ? { type: 'sent' }
      : {
          type: 'refused',
          code: result.value.code,
          message: result.value.message.includes(name)
            ? result.value.message
            : `${name}: ${result.value.message}`,
        };
  }
  const { failure, mutated } = result;
  const code = failureCode(failure);
  const unknown: OfferAnswerOutcome = {
    type: 'unknown',
    code,
    message: `Listora isn't sure your answer reached ${name} and is checking the offer.`,
  };
  if (mutated) return unknown;
  switch (failure.kind) {
    case 'challenge':
      return {
        type: 'needs_seller',
        code,
        message: `${challengeMessage(failure.challenge, name)} Or answer this offer in ${name}.`,
      };
    case 'timeout':
      return { type: 'not_sent', code, message: `${name} took too long to answer.` };
    case 'error':
      switch (failure.code) {
        case 'element_missing':
          return {
            type: 'needs_seller',
            code,
            message: `Listora couldn't read ${name}'s offer page, so it can't answer it. Answer it in ${name}.`,
          };
        case 'stopped_for_check':
          return {
            type: 'not_sent',
            code,
            message: `${name} wants you to complete a check on your iPhone. Open Listora there to finish it.`,
          };
        case 'rate_limited':
          return {
            type: 'not_sent',
            code,
            message: `${name} asked Listora to slow down.`,
            ...(failure.retryAfterMs === null ? {} : { retryAfterMs: failure.retryAfterMs }),
          };
        case 'read_only':
          return { type: 'needs_seller', code, message: readOnlyOfferMessage(name) };
        case 'server_error':
        case 'unreachable':
        case 'aborted':
        case 'browser_unavailable':
        case 'script_error':
          return { type: 'not_sent', code, message: `${name} didn't respond as expected.` };
        default:
          return assertNever(failure.code, 'script error code');
      }
    default:
      return assertNever(failure, 'script failure');
  }
}

function readOnlyOfferMessage(name: string): string {
  return `This ${name} account is read only in Listora, so it can't answer its offers. Answer this one in ${name}.`;
}

function degradedMessage(code: string, name: string): string {
  switch (code) {
    case 'browser_unavailable':
      return `Listora's browser didn't start, so it couldn't check your ${name} sign-in. The problem is on Listora's side, not ${name}'s.`;
    case 'stopped_for_check':
      return `${name} wants you to complete a check on your iPhone before Listora can confirm your sign-in. Open Listora there to finish it.`;
    default:
      return `Listora couldn't check your ${name} sign-in just now.`;
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

/** What the script said of why it stopped (already sanitized), for the owner's alert. */
function failureDetail(failure: ScriptFailure): string | null {
  switch (failure.kind) {
    case 'challenge':
      return `the page showed a ${failure.challenge}`;
    case 'timeout':
      return 'the step ran out of time';
    case 'error':
      return failure.message === '' ? null : failure.message;
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

/** The seller a write must find signed in: the connection's, once a session check read it. */
function expectedSeller(connection: ConnectionRef): { expectedSeller?: string } {
  return typeof connection.sellerId === 'string' ? { expectedSeller: connection.sellerId } : {};
}
