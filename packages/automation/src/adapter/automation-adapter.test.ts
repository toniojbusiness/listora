/**
 * How the automation adapter maps every way a run can end onto an engine outcome, without a
 * browser: never more than it knows, and a check or a page it no longer understands goes to
 * the user.
 */
import { describe, expect, it } from 'vitest';

import {
  checkCapabilities,
  createMercariAdapter,
  operationMode,
  type AssistedListingPayload,
  type OperationRequest,
} from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { automationProfile } from '../profiles.ts';
import type { ScriptFailure, ScriptResult } from '../runner/types.ts';
import { silentLogger } from '../test-support.ts';
import {
  AutomationAdapter,
  type AutomationScripts,
  type WriteResult,
} from './automation-adapter.ts';
import type { AutomationSessions, SessionRequest, SessionRun } from './sessions.ts';

class StubSessions implements AutomationSessions {
  next: SessionRun<unknown> | Error = { type: 'no_session' };
  readonly requests: SessionRequest[] = [];

  use<T>(request: SessionRequest): Promise<SessionRun<T>> {
    this.requests.push(request);
    const next = this.next;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as SessionRun<T>);
  }
}

const never = () => Promise.reject(new Error('stub sessions never run scripts'));
const SCRIPTS: AutomationScripts<AssistedListingPayload> = {
  create: never,
  price: never,
  end: never,
  read: never,
  health: never,
  orders: never,
};

function setup(scripts: AutomationScripts<AssistedListingPayload> = SCRIPTS) {
  const sessions = new StubSessions();
  const adapter = new AutomationAdapter({
    marketplace: 'mercari',
    profile: automationProfile('mercari'),
    sessions,
    assisted: createMercariAdapter(),
    scripts,
    readFreshness: 'none',
    logger: silentLogger,
  });
  return { sessions, adapter };
}

const connection = { id: 'connection-1', mode: 'automation', status: 'connected' } as const;
const ctx = { signal: new AbortController().signal, connection, operationId: 'op-1' };

function createOp(): OperationRequest<AssistedListingPayload> {
  const { adapter } = setup();
  const { item, variant } = sampleListingContent();
  return {
    operationId: 'op-1',
    kind: 'create',
    idempotencyKey: 'key-1',
    attempt: 1,
    desired: { status: 'active' },
    listing: {
      listingId: 'listing-1',
      externalListingId: null,
      externalSku: 'SKU-1',
      externalUrl: null,
    },
    payload: adapter.buildPayload(item, variant),
  };
}

function ran(
  result: Partial<ScriptResult<WriteResult>> & Pick<ScriptResult<WriteResult>, 'ok'>,
): SessionRun<WriteResult> {
  return {
    type: 'ran',
    result: { mutated: false, steps: ['a step'], ...result } as ScriptResult<WriteResult>,
  };
}

function failedWith(failure: ScriptFailure, mutated: boolean): SessionRun<WriteResult> {
  return { type: 'ran', result: { ok: false, failure, mutated, steps: ['fill', 'publish'] } };
}

const error = (
  code: Extract<ScriptFailure, { kind: 'error' }>['code'],
  retryAfterMs: number | null = null,
) =>
  ({
    kind: 'error',
    step: 'publish',
    code,
    message: 'x',
    retryAfterMs,
    screenshotKey: null,
  }) as const;

describe('AutomationAdapter', () => {
  it('automates the kinds it has scripts for, verifies by its own reads, and leaves the rest assisted', () => {
    const { adapter } = setup();
    const capabilities = adapter.capabilities();
    expect(checkCapabilities(capabilities)).toEqual([]);
    expect(capabilities).toMatchObject({
      connect: 'session',
      verifyRead: 'automation',
      readFreshness: 'none',
      saleDetection: ['poll', 'email', 'manual'],
      imageTransport: 'upload',
    });
    expect(operationMode(capabilities, 'create')).toBe('automation');
    expect(operationMode(capabilities, 'price')).toBe('automation');
    expect(operationMode(capabilities, 'end')).toBe('automation');
    expect(operationMode(capabilities, 'revise')).toBe('assisted');
    expect(operationMode(capabilities, 'relist')).toBe('assisted');
    expect(operationMode(capabilities, 'verify')).toBe('automation');
    const withoutOrders = { ...SCRIPTS };
    delete withoutOrders.orders;
    const { adapter: noOrders } = setup(withoutOrders);
    expect(noOrders.capabilities().saleDetection).toEqual(['email', 'manual']);
  });

  it('serves a kind without a script as the user task, without a browser', async () => {
    const { adapter, sessions } = setup();
    const op = { ...createOp(), kind: 'revise' as const };
    expect(await adapter.execute(op, ctx)).toMatchObject({
      type: 'pendingUser',
      task: { kind: 'edit_manually' },
    });
    expect(sessions.requests).toEqual([]);
  });

  it('confirms only an applied script, which the engine still reads back', async () => {
    const { adapter, sessions } = setup();
    sessions.next = ran({
      ok: true,
      value: { type: 'applied', externalListingId: 'L9', revision: 4 },
    });
    expect(await adapter.execute(createOp(), ctx)).toMatchObject({
      type: 'confirmed',
      externalListingId: 'L9',
      revision: 4,
      excerpt: { script: 'create', steps: ['a step'], result: 'applied' },
    });
    expect(sessions.requests).toEqual([
      { connection, purpose: 'operation', operationId: 'op-1', script: 'create' },
    ]);
  });

  it("rejects with the marketplace's own words, naming it", async () => {
    const { adapter, sessions } = setup();
    sessions.next = ran({
      ok: true,
      value: { type: 'rejected', code: 'validation_failed', message: 'Add a brand.' },
    });
    expect(await adapter.execute(createOp(), ctx)).toMatchObject({
      type: 'rejected',
      code: 'validation_failed',
      message: 'Mercari: Add a brand.',
    });
  });

  it('falls back to the user at a check, a missing session, or a page it no longer understands', async () => {
    const { adapter, sessions } = setup();
    for (const next of [
      failedWith(
        { kind: 'challenge', challenge: 'captcha', step: 'publish', screenshotKey: 'k' },
        true,
      ),
      { type: 'no_session' } as const,
      failedWith(error('element_missing'), false),
    ]) {
      sessions.next = next;
      expect(await adapter.execute(createOp(), ctx)).toMatchObject({
        type: 'pendingUser',
        task: { kind: 'list_manually', payload: { action: 'create' } },
      });
    }
  });

  it('calls a failure after a mutating step unknown, and one before it worth another try', async () => {
    const { adapter, sessions } = setup();
    const cases: [SessionRun<WriteResult>, string][] = [
      [failedWith({ kind: 'timeout', step: 'publish', screenshotKey: null }, true), 'unknown'],
      [failedWith({ kind: 'timeout', step: 'fill', screenshotKey: null }, false), 'transient'],
      [failedWith(error('unreachable'), true), 'unknown'],
      [failedWith(error('unreachable'), false), 'transient'],
      [failedWith(error('script_error'), true), 'unknown'],
      [failedWith(error('aborted'), false), 'transient'],
      [failedWith(error('element_missing'), true), 'unknown'],
      // A 5xx may hide an applied change; the engine reads back before sending again.
      [failedWith(error('server_error'), true), 'transient'],
    ];
    for (const [next, type] of cases) {
      sessions.next = next;
      expect((await adapter.execute(createOp(), ctx)).type, JSON.stringify(next)).toBe(type);
    }
  });

  it("waits out the marketplace's and the seller's limits", async () => {
    const { adapter, sessions } = setup();
    sessions.next = failedWith(error('rate_limited', 9_000), true);
    expect(await adapter.execute(createOp(), ctx)).toMatchObject({
      type: 'transient',
      code: 'rate_limited',
      retryAfterMs: 9_000,
    });
    sessions.next = { type: 'rate_limited', retryAfterMs: 60_000 };
    expect(await adapter.execute(createOp(), ctx)).toMatchObject({
      type: 'transient',
      code: 'automation_paced',
      retryAfterMs: 60_000,
    });
    sessions.next = { type: 'busy', retryAfterMs: 30_000 };
    expect(await adapter.execute(createOp(), ctx)).toMatchObject({
      type: 'transient',
      code: 'automation_busy',
    });
  });

  it("never throws: Listora's own failure around a run is unknown, for a read-back to decide", async () => {
    const { adapter, sessions } = setup();
    sessions.next = new Error('database down');
    expect(await adapter.execute(createOp(), ctx)).toMatchObject({
      type: 'unknown',
      code: 'automation_error',
    });
  });

  it('throws for reads it cannot make, instead of reporting the listing missing', async () => {
    const { adapter, sessions } = setup();
    const ref = createOp().listing;
    for (const next of [
      { type: 'no_session' } as const,
      { type: 'busy', retryAfterMs: 1 } as const,
      failedWith(
        { kind: 'challenge', challenge: 'bot_check', step: 'read', screenshotKey: null },
        false,
      ),
    ]) {
      sessions.next = next;
      await expect(adapter.readListing(ref, ctx)).rejects.toThrow('Mercari');
    }
    sessions.next = {
      type: 'ran',
      result: {
        ok: true,
        value: { found: false, authoritative: false },
        mutated: false,
        steps: [],
      },
    };
    expect(await adapter.readListing(ref, ctx)).toEqual({ found: false, authoritative: false });
    expect(sessions.requests.at(-1)).toMatchObject({ purpose: 'operation', operationId: 'op-1' });
  });

  it('reports a session that needs relinking, and degrades on anything else', async () => {
    const { adapter, sessions } = setup();
    sessions.next = { type: 'no_session' };
    expect(await adapter.healthCheck(ctx)).toMatchObject({ status: 'reauth_required' });
    sessions.next = failedWith(
      { kind: 'challenge', challenge: 'session_rejected', step: 'open', screenshotKey: null },
      false,
    );
    expect(await adapter.healthCheck(ctx)).toMatchObject({
      status: 'reauth_required',
      code: 'session_rejected',
    });
    sessions.next = failedWith(error('server_error'), false);
    expect(await adapter.healthCheck(ctx)).toMatchObject({
      status: 'degraded',
      code: 'server_error',
    });
    sessions.next = new Error('database down');
    expect(await adapter.healthCheck(ctx)).toMatchObject({ status: 'degraded' });
    sessions.next = {
      type: 'ran',
      result: { ok: true, value: undefined, mutated: false, steps: [] },
    };
    expect(await adapter.healthCheck(ctx)).toEqual({ status: 'ok' });
    expect(await adapter.healthCheck({ ...ctx, connection: null })).toEqual({ status: 'ok' });
  });
});
