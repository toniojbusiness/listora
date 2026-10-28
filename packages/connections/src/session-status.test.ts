import { describe, expect, it } from 'vitest';

import {
  describeAutomationSession,
  SESSION_CHECK_DEADLINE_MS,
  type AutomationSessionInput,
  type SessionCheckState,
} from './session-status.ts';
import { describeConnection } from './status-display.ts';
import type { ConnectionRow } from './store.ts';

const NOW = new Date('2026-10-25T23:40:00.000Z');
const LINKED_AT = new Date(NOW.getTime() - 60_000);

function check(overrides: Partial<SessionCheckState> = {}): SessionCheckState {
  return {
    status: 'pending',
    attempts: 0,
    failureCode: null,
    failureMessage: null,
    requestedAt: LINKED_AT,
    finishedAt: null,
    ...overrides,
  };
}

function session(
  sessionCheck: SessionCheckState | null,
  connection: Partial<AutomationSessionInput['connection']> = {},
  now = NOW,
  phone?: AutomationSessionInput['phone'],
) {
  return describeAutomationSession({
    marketplace: 'poshmark',
    connection: {
      status: 'connected',
      displayName: null,
      lastError: null,
      lastErrorCode: null,
      lastErrorAt: null,
      updatedAt: LINKED_AT,
      ...connection,
    },
    check: sessionCheck,
    now,
    ...(phone === undefined ? {} : { phone }),
  });
}

describe('describeAutomationSession', () => {
  it('is checking while the check runs, and linked only once it passed', () => {
    expect(session(check())).toEqual({
      state: 'checking',
      statusDisplay: {
        tone: 'checking',
        label: 'Checking...',
        detail: 'Listora is checking that Poshmark accepts your sign-in.',
      },
      canCheck: false,
    });
    expect(
      session(check({ status: 'passed', finishedAt: NOW }), { displayName: 'closet_queen' }),
    ).toEqual({
      state: 'linked',
      statusDisplay: { tone: 'success', label: 'Linked', detail: 'Signed in as closet_queen.' },
      canCheck: false,
    });
  });

  it('says when it waits for the phone, never that an attempt failed and is tried again', () => {
    const waiting = { linked: true, checkWaiting: true };
    const onPhone = {
      tone: 'checking',
      label: 'Checking on your iPhone...',
      detail: 'Open Listora on your iPhone to finish checking your Poshmark sign-in.',
    };
    expect(session(check(), {}, NOW, waiting).statusDisplay).toEqual(onPhone);
    expect(session(check({ attempts: 1 }), {}, NOW, waiting).statusDisplay).toEqual(onPhone);
    expect(session(check({ attempts: 2 })).statusDisplay).toEqual({
      tone: 'checking',
      label: 'Checking...',
      detail: 'Listora is checking that Poshmark accepts your sign-in.',
    });
  });

  it('stops checking at the deadline: a check that did not finish is not confirmed', () => {
    const requestedAt = new Date(NOW.getTime() - SESSION_CHECK_DEADLINE_MS);
    expect(session(check({ requestedAt }), {}, new Date(NOW.getTime() - 1)).state).toBe('checking');
    expect(session(check({ requestedAt }))).toEqual({
      state: 'not_confirmed',
      statusDisplay: {
        tone: 'action_needed',
        label: 'Not confirmed',
        detail:
          "Listora's check of your Poshmark sign-in didn't finish. Check again, or link Poshmark again if it keeps failing.",
      },
      issue: {
        code: 'check_timed_out',
        message: "Listora's check of your Poshmark sign-in didn't finish.",
        occurredAt: NOW,
      },
      canCheck: true,
    });
  });

  it('is not confirmed, with the reason, when the check failed or never ran', () => {
    expect(
      session(
        check({
          status: 'failed',
          failureCode: 'browser_unavailable',
          failureMessage: "Listora's browser didn't start.",
          finishedAt: NOW,
        }),
      ),
    ).toMatchObject({
      state: 'not_confirmed',
      issue: { code: 'browser_unavailable', occurredAt: NOW },
      canCheck: true,
    });
    expect(session(null)).toMatchObject({
      state: 'not_confirmed',
      issue: {
        code: 'check_missing',
        message: "Listora hasn't checked your Poshmark sign-in yet.",
      },
      canCheck: true,
    });
  });

  it('needs a relink once the marketplace rejected the session, whatever the check said', () => {
    expect(
      session(check({ status: 'passed', finishedAt: LINKED_AT }), {
        status: 'reauth_required',
        lastError: 'Poshmark showed a check Listora must not pass. Log in again.',
        lastErrorCode: 'captcha',
        lastErrorAt: NOW,
      }),
    ).toEqual({
      state: 'needs_relink',
      statusDisplay: {
        tone: 'action_needed',
        label: 'Sign in again',
        detail: 'Poshmark showed a check Listora must not pass. Log in again.',
      },
      issue: {
        code: 'captcha',
        message: 'Poshmark showed a check Listora must not pass. Log in again.',
        occurredAt: NOW,
      },
      canCheck: false,
    });
  });
});

describe('describeConnection of an automation connection', () => {
  const row: ConnectionRow = {
    id: '0199a1f0-0000-7000-8000-00000000c002',
    account_id: '0199a1f0-0000-7000-8000-00000000a001',
    marketplace: 'poshmark',
    mode: 'automation',
    external_user_id: null,
    display_name: null,
    token_ciphertext: Buffer.from('sealed session'),
    access_expires_at: null,
    refresh_expires_at: null,
    scopes: [],
    status: 'connected',
    last_ok_at: null,
    last_error: null,
    last_error_code: null,
    last_error_at: null,
    granted_at: LINKED_AT,
    orders_polled_through: null,
    credential_version: 1,
    last_checked_at: null,
    check_requested_at: null,
    runs_on: 'cloud',
    phone_device_id: null,
    read_only: false,
    created_at: LINKED_AT,
    updated_at: LINKED_AT,
  };
  const marketplaces = (sessionCheck: SessionCheckState | null) =>
    describeConnection({
      marketplace: 'poshmark',
      row,
      defaultMode: 'assisted',
      canConnect: false,
      sessionCheck,
      now: NOW,
    });

  it('says what Link accounts says, never Connected for a session Listora did not confirm', () => {
    for (const sessionCheck of [
      null,
      check(),
      check({ requestedAt: new Date(NOW.getTime() - SESSION_CHECK_DEADLINE_MS) }),
      check({ status: 'failed', failureCode: 'x', failureMessage: 'Why.', finishedAt: NOW }),
      check({ status: 'passed', finishedAt: NOW }),
    ]) {
      const linkAccounts = session(sessionCheck);
      const view = marketplaces(sessionCheck);
      expect(view.statusDisplay).toEqual(linkAccounts.statusDisplay);
      expect(view.lastIssue).toEqual(linkAccounts.issue);
      expect(view.actions).toEqual(linkAccounts.canCheck ? ['check'] : []);
      expect(view.attention).toBe(
        linkAccounts.state === 'not_confirmed' ? 'not_confirmed' : undefined,
      );
      expect(view.lastOkAt).toEqual(linkAccounts.state === 'linked' ? NOW : undefined);
    }
  });
});
