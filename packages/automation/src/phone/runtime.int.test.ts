/**
 * The phone runtime's own rule (docs/features/phone-execution.md), on the fake Depop site in
 * headless Chromium standing in for the app's web view: a check the run stops at is handed to
 * the seller, never solved or skipped. A check the seller completes runs the call again from its
 * start when nothing had changed yet; one they decline, or could not be asked about (the app in
 * the background), stops the run as `stopped_for_check`, which retries later, except a sign-in
 * page they decline, which asks for a new link. The shared conformance suites
 * (conformance-<marketplace>.int.test.ts) cover everything the phone does the same way as the
 * runner.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  AdapterContext,
  ListingRef,
  OperationRequest,
  WriteOperationKind,
} from '@listora/marketplaces';
import { desiredStateForContent, isContentKind } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { createDepopAutomationAdapter } from '../depop/adapter.ts';
import { DEPOP_STEP_TIMEOUT_MS } from '../depop/fake/conformance-driver.ts';
import { FakeDepopSite, type FakeDepopSiteFaultRule } from '../depop/fake/fake-depop-site.ts';
import type { DepopAutomationPayload } from '../depop/payload.ts';
import { automationProfile, standInProfile } from '../profiles.ts';
import { QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import type { HandOffAnswer } from './host.ts';
import { PhoneTestSessions, type PlaywrightPhoneHost } from './test-host.ts';

const connection = { id: 'connection-depop', mode: 'automation', status: 'connected' } as const;
const ctx = (): AdapterContext => ({ signal: new AbortController().signal, connection });

describe('the phone runtime hands a check to the seller', () => {
  let site: FakeDepopSite;
  let sessions: PhoneTestSessions;
  let adapter: ReturnType<typeof createDepopAutomationAdapter>;
  let sequence = 0;
  /** What the seller does with each check, in order; the default for any after them. */
  let answers: (HandOffAnswer | ((host: PlaywrightPhoneHost) => HandOffAnswer))[] = [];
  let otherwise: HandOffAnswer = 'declined';

  beforeAll(async () => {
    site = await FakeDepopSite.start();
    sessions = new PhoneTestSessions(
      site,
      { ...standInProfile(automationProfile('depop'), site.url), pacing: QUICK_PACING },
      DEPOP_STEP_TIMEOUT_MS,
    );
    sessions.prepare = (host) => {
      host.defaultAnswer = otherwise;
      host.answers = answers.map((answer) =>
        typeof answer === 'function' ? () => Promise.resolve(answer(host)) : answer,
      );
    };
    adapter = createDepopAutomationAdapter({
      siteUrl: site.url,
      profile: { ...automationProfile('depop'), pacing: QUICK_PACING },
      sessions,
      photos: stubPhotos,
      logger: silentLogger,
    });
  });

  afterEach(() => {
    site.clearFaults();
    answers = [];
    otherwise = 'declined';
  });

  afterAll(async () => {
    await sessions.close();
    await site.close();
  });

  function newRef(): ListingRef {
    sequence += 1;
    const id = `phone-${String(process.pid)}-${String(sequence)}`;
    return { listingId: id, externalListingId: null, externalSku: `SKU-${id}`, externalUrl: null };
  }

  function request(
    kind: WriteOperationKind,
    listing: ListingRef,
  ): OperationRequest<DepopAutomationPayload> {
    const content = sampleListingContent();
    const base = {
      operationId: `op-${listing.listingId}-${kind}`,
      kind,
      idempotencyKey: `key-${listing.listingId}-${kind}`,
      attempt: 1,
      listing,
    };
    if (isContentKind(kind)) {
      return {
        ...base,
        desired: desiredStateForContent(kind, content),
        payload: adapter.buildPayload(content.item, content.variant),
      };
    }
    return { ...base, desired: { status: 'ended' as const }, payload: null };
  }

  const inject = (rule: FakeDepopSiteFaultRule): void => {
    site.inject(rule);
  };
  const lastHost = (): PlaywrightPhoneHost => {
    const host = sessions.hosts.at(-1);
    if (host === undefined) throw new Error('no run yet');
    return host;
  };

  it('runs the call again once the seller completed the check, and posts once', async () => {
    const ref = newRef();
    inject({ action: 'form', fault: { type: 'captcha' } });
    answers = ['completed'];
    const outcome = await adapter.execute(request('create', ref), ctx());
    expect(outcome).toMatchObject({ type: 'confirmed' });
    expect(lastHost().handOffs).toEqual([{ kind: 'captcha', marketplace: 'depop' }]);
    expect(site.productsWithSku(ref.externalSku ?? '')).toHaveLength(1);
  });

  it('runs a health check again after a bot check the seller completed', async () => {
    inject({ action: 'health', fault: { type: 'bot_check' } });
    answers = ['completed'];
    expect(await adapter.healthCheck(ctx())).toEqual({ status: 'ok' });
    expect(lastHost().handOffs).toEqual([{ kind: 'bot_check', marketplace: 'depop' }]);
  });

  it('stops for later when the seller declines a check, and lists nothing', async () => {
    const ref = newRef();
    inject({ action: 'form', fault: { type: 'login_challenge' } });
    answers = ['declined'];
    expect(await adapter.execute(request('create', ref), ctx())).toMatchObject({
      type: 'transient',
      code: 'stopped_for_check',
      message: expect.stringContaining('complete a check on your iPhone') as unknown,
    });
    expect(site.productsWithSku(ref.externalSku ?? '')).toHaveLength(0);
  });

  it('stops for later in the background, where nobody can be asked', async () => {
    inject({ action: 'health', fault: { type: 'captcha' } });
    answers = ['unavailable'];
    expect(await adapter.healthCheck(ctx())).toMatchObject({
      status: 'degraded',
      code: 'stopped_for_check',
      message: expect.stringContaining('Open Listora') as unknown,
    });
  });

  it('asks for a new link when the seller declines to sign in again', async () => {
    const ref = newRef();
    inject({ action: 'form', fault: { type: 'session_expired' } });
    answers = ['declined'];
    expect(await adapter.execute(request('create', ref), ctx())).toMatchObject({
      type: 'pendingUser',
      excerpt: {
        automation: 'challenge',
        failure: { kind: 'challenge', code: 'session_rejected' },
      },
    });
  });

  it('leaves the answer to a read-back when the check came after the post', async () => {
    const ref = newRef();
    inject({ action: 'create', fault: { type: 'bot_check' } });
    answers = ['completed'];
    // The post may have gone through, so the call is not run again: the read-back decides.
    expect(await adapter.execute(request('create', ref), ctx())).toMatchObject({
      type: 'unknown',
      code: 'stopped_for_check',
    });
    expect(lastHost().handOffs).toHaveLength(1);
  });

  it('hands a check that keeps coming back to the seller at most twice', async () => {
    inject({ action: 'health', fault: { type: 'captcha' }, times: 5 });
    otherwise = 'completed';
    expect(await adapter.healthCheck(ctx())).toMatchObject({
      status: 'degraded',
      code: 'stopped_for_check',
    });
    expect(lastHost().handOffs).toHaveLength(2);
  });

  it('keeps the session when a sign-in page comes while the app is in the background', async () => {
    inject({ action: 'health', fault: { type: 'session_expired' } });
    otherwise = 'unavailable';
    const health = await adapter.healthCheck(ctx());
    expect(health).toMatchObject({ status: 'degraded', code: 'stopped_for_check' });
    expect(lastHost().handOffs).toEqual([{ kind: 'session_rejected', marketplace: 'depop' }]);
  });
});
