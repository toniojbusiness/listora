import { describe, expect, it } from 'vitest';

import { describeConnection } from './status-display.ts';
import type { ConnectionRow } from './store.ts';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const DAY = 86_400_000;

function row(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: '0199a1f0-0000-7000-8000-00000000c001',
    account_id: '0199a1f0-0000-7000-8000-00000000a001',
    marketplace: 'ebay',
    mode: 'api',
    external_user_id: 'u1',
    display_name: 'listora_seller',
    token_ciphertext: Buffer.from('sealed'),
    access_expires_at: new Date(NOW.getTime() + 3_600_000),
    refresh_expires_at: new Date(NOW.getTime() + 400 * DAY),
    scopes: [],
    status: 'connected',
    last_ok_at: NOW,
    last_error: null,
    last_error_code: null,
    last_error_at: null,
    granted_at: new Date(NOW.getTime() - 10 * DAY),
    orders_polled_through: null,
    credential_version: 0,
    last_checked_at: NOW,
    check_requested_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const describeEbay = (connection: ConnectionRow | undefined, canConnect = true) =>
  describeConnection({
    marketplace: 'ebay',
    row: connection,
    defaultMode: 'api',
    canConnect,
    now: NOW,
  });

describe('describeConnection', () => {
  it('offers to connect an API marketplace with no connection', () => {
    expect(describeEbay(undefined)).toEqual({
      marketplace: 'ebay',
      mode: 'api',
      status: 'not_connected',
      statusDisplay: {
        tone: 'neutral',
        label: 'Not connected',
        detail:
          'Connect your eBay account so Listora can list, update, and end your items there, and confirm every change with eBay.',
      },
      actions: ['connect'],
    });
  });

  it('says "coming soon" and offers nothing when this environment cannot connect', () => {
    expect(describeEbay(undefined, false)).toMatchObject({
      status: 'not_connected',
      statusDisplay: { label: 'Coming soon', detail: "Listora can't connect to eBay yet." },
      actions: [],
    });
  });

  it('shows assisted marketplaces as not linked, never as connected', () => {
    expect(
      describeConnection({
        marketplace: 'poshmark',
        row: undefined,
        defaultMode: 'assisted',
        canConnect: false,
        now: NOW,
      }),
    ).toMatchObject({
      mode: 'assisted',
      status: 'not_connected',
      statusDisplay: {
        tone: 'neutral',
        label: 'Not linked',
        detail:
          'Listora works with Poshmark in assisted mode: it prepares each listing and change, and you finish it in the Poshmark app, then confirm it.',
      },
      actions: [],
    });
  });

  it('shows a working connection as connected, with its seller and dates', () => {
    expect(describeEbay(row())).toMatchObject({
      status: 'connected',
      statusDisplay: {
        tone: 'success',
        label: 'Connected',
        detail: 'Signed in as listora_seller.',
      },
      actions: [],
      displayName: 'listora_seller',
      connectedAt: new Date(NOW.getTime() - 10 * DAY),
      grantExpiresAt: new Date(NOW.getTime() + 400 * DAY),
      lastOkAt: NOW,
      lastCheckedAt: NOW,
    });
  });

  it('warns 30 days before the grant expires and offers to reconnect', () => {
    const expiresAt = new Date(NOW.getTime() + 30 * DAY);
    expect(describeEbay(row({ refresh_expires_at: expiresAt }))).toMatchObject({
      status: 'connected',
      statusDisplay: {
        tone: 'action_needed',
        label: 'Reconnect within 30 days',
        detail:
          "Listora's eBay access ends on November 23, 2026. Reconnect eBay before then to keep your listings in sync.",
      },
      actions: ['reconnect'],
    });
    expect(
      describeEbay(row({ refresh_expires_at: new Date(NOW.getTime() + 31 * DAY) })).statusDisplay
        .label,
    ).toBe('Connected');
    expect(
      describeEbay(row({ refresh_expires_at: new Date(NOW.getTime() + 3_600_000) })).statusDisplay
        .label,
    ).toBe('Reconnect within 1 day');
  });

  it('shows a degraded connection as a problem Listora keeps checking', () => {
    expect(
      describeEbay(
        row({
          status: 'degraded',
          last_error: 'eBay had a problem. Try again soon.',
          last_error_code: 'marketplace_error',
          last_error_at: NOW,
        }),
      ),
    ).toMatchObject({
      status: 'degraded',
      statusDisplay: {
        tone: 'checking',
        label: 'Connection problem',
        detail: 'eBay had a problem. Try again soon. Listora keeps checking.',
      },
      actions: ['check', 'reconnect'],
      attention: 'connection_problem',
      lastIssue: { code: 'marketplace_error', message: 'eBay had a problem. Try again soon.' },
    });
  });

  it('shows a check the seller asked for as Checking until the worker finishes it', () => {
    const degraded = {
      status: 'degraded' as const,
      last_error: 'eBay had a problem. Try again soon.',
      last_error_code: 'marketplace_error',
      last_error_at: NOW,
      last_checked_at: new Date(NOW.getTime() - 60_000),
    };
    expect(
      describeEbay(row({ ...degraded, check_requested_at: new Date(NOW.getTime() - 1_000) })),
    ).toMatchObject({
      status: 'degraded',
      statusDisplay: {
        tone: 'checking',
        label: 'Checking...',
        detail: 'Listora is checking your eBay connection now.',
      },
      actions: [],
      attention: 'connection_problem',
    });
    // Finished: the result shows again.
    expect(
      describeEbay(row({ ...degraded, check_requested_at: new Date(NOW.getTime() - 120_000) }))
        .statusDisplay.label,
    ).toBe('Connection problem');
    // Never finished (the job was lost): after 10 minutes it stops saying Checking.
    expect(
      describeEbay(
        row({
          ...degraded,
          last_checked_at: null,
          check_requested_at: new Date(NOW.getTime() - 11 * 60_000),
        }),
      ).statusDisplay.label,
    ).toBe('Connection problem');
    // Only a connection that holds its grant is checked.
    expect(
      describeEbay(
        row({
          status: 'reauth_required',
          last_error: 'Reconnect eBay.',
          last_error_code: 'grant_revoked',
          last_error_at: NOW,
          check_requested_at: NOW,
        }),
      ).statusDisplay.label,
    ).toBe('Reconnect needed');
  });

  it('warns 30 days before a Depop grant (one year) ends, and not before', () => {
    const depop = (daysLeft: number) =>
      describeConnection({
        marketplace: 'depop',
        row: row({
          marketplace: 'depop',
          granted_at: new Date(NOW.getTime() - (365 - daysLeft) * DAY),
          refresh_expires_at: new Date(NOW.getTime() + daysLeft * DAY),
        }),
        defaultMode: 'api',
        canConnect: true,
        now: NOW,
      });
    expect(depop(30)).toMatchObject({
      status: 'connected',
      statusDisplay: {
        tone: 'action_needed',
        label: 'Reconnect within 30 days',
        detail:
          "Listora's Depop access ends on November 23, 2026. Reconnect Depop before then to keep your listings in sync.",
      },
      actions: ['reconnect'],
      attention: 'expiring',
    });
    expect(depop(31)).toMatchObject({
      statusDisplay: { tone: 'success', label: 'Connected' },
      actions: [],
    });
    expect(depop(31).attention).toBeUndefined();
    expect(depop(0)).toMatchObject({ status: 'reauth_required', attention: 'reconnect' });
  });

  it('asks to reconnect when reauthorization is required or the grant expired', () => {
    expect(
      describeEbay(
        row({
          status: 'reauth_required',
          last_error: 'eBay no longer accepts it.',
          last_error_code: 'grant_revoked',
          last_error_at: NOW,
        }),
      ),
    ).toMatchObject({
      status: 'reauth_required',
      statusDisplay: {
        tone: 'action_needed',
        label: 'Reconnect needed',
        detail: 'eBay no longer accepts it.',
      },
      actions: ['reconnect'],
    });
    expect(describeEbay(row({ refresh_expires_at: NOW }))).toMatchObject({
      status: 'reauth_required',
      statusDisplay: {
        label: 'Reconnect needed',
        detail: "Listora's eBay access expired. Reconnect eBay to keep your listings in sync.",
      },
    });
  });

  it('shows a revoked connection as access removed', () => {
    expect(
      describeEbay(
        row({
          status: 'revoked',
          token_ciphertext: null,
          last_error: 'You removed Listora.',
          last_error_code: 'revoked_by_seller',
          last_error_at: NOW,
        }),
      ),
    ).toMatchObject({
      status: 'revoked',
      statusDisplay: {
        tone: 'action_needed',
        label: 'Access removed',
        detail: 'You removed Listora.',
      },
      actions: ['reconnect'],
    });
  });
});
