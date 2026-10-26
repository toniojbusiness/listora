/**
 * The phone's API (docs/features/phone-execution.md), on real Postgres: registering a device,
 * linking a marketplace that runs on the phone from it, what Link accounts and Marketplaces
 * then say (where it runs, and the phone-side state, never "Sign in again" for a session the
 * phone has not checked), claiming and answering the session check's phone run, the refusals
 * (an unknown device, an app that needs an update, a call the run is not waiting for), and
 * where a connection may run: a marketplace that refuses Listora's cloud stays on the phone
 * unless configured back, and then moves to the cloud and back. The phone runtime's own runs against the fake marketplace
 * sites are in @listora/automation (phone/work.int.test.ts).
 */
import { randomUUID } from 'node:crypto';

import { PHONE_RUNTIME_VERSION, PHONE_UNUSED_CLAIM_SECONDS } from '@listora/automation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';

const SELLER = 'phone-seller@example.com';
const NOW_SECONDS = Math.floor(Date.now() / 1000);

const depopCookie = {
  name: 'access_token',
  value: 'depop-session-secret',
  domain: '.depop.com',
  path: '/',
  expires: NOW_SECONDS + 86_400,
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
} as const;

describe('the phone API (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  const installationId = randomUUID();

  beforeAll(async () => {
    api = await createTestApi('phone');
    token = await api.signIn(SELLER);
  });

  afterAll(async () => {
    await api.close();
  });

  const register = (body: Record<string, unknown>, id = installationId) =>
    api.call('registerDevice', { token, params: { installationId: id }, body });
  const claim = (runtimeVersion = PHONE_RUNTIME_VERSION, id = installationId) =>
    api.call('claimPhoneRun', { token, body: { installationId: id, runtimeVersion } });
  const session = () =>
    api.call('getMarketplaceSession', { token, params: { marketplace: 'depop' } });
  const connection = () => api.call('getConnection', { token, params: { marketplace: 'depop' } });

  it('registers the device, and moves a push token to the installation that has it now', async () => {
    const registered = await register({
      name: "Tonio's iPhone",
      platform: 'ios',
      appVersion: '1.4.0',
      runtimeVersion: PHONE_RUNTIME_VERSION,
      pushToken: 'ab'.repeat(32),
      pushEnvironment: 'sandbox',
    });
    expect(registered.status).toBe(200);
    expect(registered.body).toMatchObject({
      installationId,
      name: "Tonio's iPhone",
      platform: 'ios',
      pushEnabled: true,
    });
    const other = randomUUID();
    expect(
      (await register({ name: 'Old iPhone', platform: 'ios', pushToken: 'ab'.repeat(32) }, other))
        .body,
    ).toMatchObject({ pushEnabled: true });
    expect((await register({ name: "Tonio's iPhone", platform: 'ios' })).body).toMatchObject({
      pushEnabled: false,
    });
    expect((await register({ name: '', platform: 'ios' })).status).toBe(422);
  });

  it('runs a marketplace linked on the phone there, and says so on both screens', async () => {
    await register({
      name: "Tonio's iPhone",
      platform: 'ios',
      runtimeVersion: PHONE_RUNTIME_VERSION,
    });
    const linked = await api.call('linkMarketplaceSession', {
      token,
      params: { marketplace: 'depop' },
      body: { cookies: [depopCookie], installationId },
    });
    expect(linked.status).toBe(201);
    const runsHere = {
      location: 'phone',
      label: 'Runs on your iPhone',
      deviceInstallationId: installationId,
      deviceName: "Tonio's iPhone",
      cloudAllowed: false,
      cloudBlockedReason: 'Depop blocks cloud servers, so Listora runs it from your phone',
    };
    expect(linked.body).toMatchObject({
      status: 'checking',
      statusDisplay: { tone: 'checking', label: 'Checking on your iPhone...' },
      execution: { ...runsHere, waiting: 2 },
    });
    expect((await connection()).body).toMatchObject({
      statusDisplay: { label: 'Checking on your iPhone...' },
      execution: runsHere,
    });

    // The phone claims the session check first and answers its one call: the page loaded.
    const claimed = await claim();
    expect(claimed.status).toBe(200);
    const run = claimed.body.run;
    expect(run).toMatchObject({
      purpose: 'session_check',
      marketplace: 'depop',
      call: { index: 0, input: { runtimeVersion: PHONE_RUNTIME_VERSION, name: 'health check' } },
    });
    if (run?.call === undefined) throw new Error('no call');
    const answer = {
      type: 'ran',
      result: { ok: true, mutated: false, steps: ['open the selling hub'] },
    };
    const answered = await api.call('answerPhoneCall', {
      token,
      params: { runId: run.id, index: String(run.call.index) },
      body: { installationId, answer },
    });
    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({});
    // The same answer again changes nothing; the run is over.
    expect(
      (
        await api.call('answerPhoneCall', {
          token,
          params: { runId: run.id, index: '0' },
          body: { installationId, answer },
        })
      ).status,
    ).toBe(404);
    expect((await session()).body).toMatchObject({
      status: 'linked',
      statusDisplay: { tone: 'success', label: 'Linked', detail: 'Runs from your iPhone.' },
    });
  });

  it('refuses another device, an unknown one, and an app that needs an update', async () => {
    expect((await claim(PHONE_RUNTIME_VERSION, randomUUID())).status).toBe(404);
    const outdated = await claim(PHONE_RUNTIME_VERSION + 1);
    expect(outdated.status).toBe(409);
    expect(outdated.error.code).toBe('app_update_required');
    const otherPhone = randomUUID();
    await register({ name: 'iPad', platform: 'ios' }, otherPhone);
    // Nothing runs on it, so it is told to look again only rarely.
    expect((await claim(PHONE_RUNTIME_VERSION, otherPhone)).body).toEqual({
      nextClaimInSeconds: PHONE_UNUSED_CLAIM_SECONDS,
    });
  });

  it('asks to link on the phone a marketplace no phone holds a session for', async () => {
    const seller = await api.signIn('phone-unlinked@example.com');
    const linked = await api.call('linkMarketplaceSession', {
      token: seller,
      params: { marketplace: 'mercari' },
      body: { cookies: [{ ...depopCookie, domain: '.mercari.com' }] },
    });
    expect(linked.body).toMatchObject({
      status: 'needs_relink',
      statusDisplay: { tone: 'action_needed', label: 'Link on your iPhone' },
      issue: { code: 'phone_link_needed' },
      execution: { location: 'phone', label: 'Link it on your iPhone to run it there' },
    });
  });

  it('refuses to move a marketplace that blocks cloud servers to the cloud', async () => {
    const refused = await api.call('setConnectionExecution', {
      token,
      params: { marketplace: 'depop' },
      body: { location: 'cloud' },
    });
    expect(refused.status).toBe(409);
    expect(refused.error).toMatchObject({
      code: 'marketplace_action_unavailable',
      message: 'Depop blocks cloud servers, so Listora runs it from your phone.',
    });
    expect((await connection()).body).toMatchObject({
      execution: { location: 'phone', label: 'Runs on your iPhone', cloudAllowed: false },
    });
    expect((await session()).body).toMatchObject({
      execution: { location: 'phone', cloudAllowed: false },
    });
    expect(
      (
        await api.call('setConnectionExecution', {
          token,
          params: { marketplace: 'poshmark' },
          body: { location: 'phone' },
        })
      ).status,
    ).toBe(409);
  });
});

describe('a marketplace configured back to the cloud (real Postgres)', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await createTestApi('phone_cloud', {
      automationEnv: { AUTOMATION_DEPOP_CLOUD_ALLOWED: 'true' },
    });
  });

  afterAll(async () => {
    await api.close();
  });

  it('offers the cloud, and moves the connection there and back', async () => {
    const token = await api.signIn('phone-cloud@example.com');
    const installationId = randomUUID();
    await api.call('registerDevice', {
      token,
      params: { installationId },
      body: { name: "Sam's iPhone", platform: 'ios', runtimeVersion: PHONE_RUNTIME_VERSION },
    });
    const linked = await api.call('linkMarketplaceSession', {
      token,
      params: { marketplace: 'depop' },
      body: { cookies: [depopCookie], installationId },
    });
    expect(linked.body).toMatchObject({ execution: { location: 'phone', cloudAllowed: true } });
    expect(linked.body.execution).not.toHaveProperty('cloudBlockedReason');

    const moved = await api.call('setConnectionExecution', {
      token,
      params: { marketplace: 'depop' },
      body: { location: 'cloud' },
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      execution: { location: 'cloud', label: "Runs in Listora's cloud", cloudAllowed: true },
    });
    const claimed = await api.call('claimPhoneRun', {
      token,
      body: { installationId, runtimeVersion: PHONE_RUNTIME_VERSION },
    });
    // Nothing runs on the phone now, so it is told to look again only rarely.
    expect(claimed.body).toEqual({ nextClaimInSeconds: PHONE_UNUSED_CLAIM_SECONDS });
    const back = await api.call('setConnectionExecution', {
      token,
      params: { marketplace: 'depop' },
      body: { location: 'phone' },
    });
    expect(back.body).toMatchObject({
      execution: { location: 'phone', label: 'Runs on your iPhone' },
    });
  });
});
