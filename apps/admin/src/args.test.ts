import { describe, expect, it } from 'vitest';

import { parseCommand, UsageError } from './args.ts';

const NOW = new Date('2026-10-24T23:30:00Z');
const ACCOUNT = '0199f3a2-7c4e-7d10-8a55-1b2c3d4e5f60';
const parse = (...argv: string[]) => parseCommand(argv, NOW);

function usageError(...argv: string[]): string {
  try {
    parse(...argv);
  } catch (error) {
    if (error instanceof UsageError) return error.message;
    throw error;
  }
  throw new Error('expected a UsageError');
}

describe('parseCommand', () => {
  it('reads an activity search by account, SKU, marketplace, and time', () => {
    expect(
      parse(
        'activity',
        '--account',
        ACCOUNT,
        '--sku',
        'aj-000184',
        '--marketplace',
        'mercari',
        '--since',
        '2026-10-26T18:00:00Z',
        '--until',
        '2026-10-27',
        '--limit',
        '10',
      ),
    ).toEqual({
      name: 'activity',
      filter: {
        accountId: ACCOUNT,
        sku: 'AJ-000184',
        marketplace: 'mercari',
        from: new Date('2026-10-26T18:00:00Z'),
        to: new Date('2026-10-27T00:00:00Z'),
      },
      limit: 10,
      json: false,
    });
    expect(parse('activity', '--operation', ACCOUNT.toUpperCase())).toEqual({
      name: 'activity',
      filter: { operationId: ACCOUNT },
      limit: 50,
      json: false,
    });
    expect(parse('sale-why', ACCOUNT, '--json')).toEqual({
      name: 'sale-why',
      saleId: ACCOUNT,
      json: true,
    });
    expect(parse('sale-checks', '--marketplace', 'depop')).toEqual({
      name: 'sale-checks',
      accountId: undefined,
      marketplace: 'depop',
      limit: 20,
      json: false,
    });
    expect(parse('sale-history', 'read', 'mercari', '--account', ACCOUNT)).toEqual({
      name: 'sale-history-read',
      accountId: ACCOUNT,
      marketplace: 'mercari',
      json: false,
    });
  });

  it('defaults cost reports to today in UTC', () => {
    expect(parse('ai-cost', 'accounts')).toEqual({
      name: 'cost-accounts',
      period: { kind: 'day', day: '2026-10-24' },
      limit: 20,
      json: false,
    });
  });

  it('reads a day or a month, a limit, and --json', () => {
    expect(parse('ai-cost', 'accounts', '--month', '2026-09', '--limit', '5', '--json')).toEqual({
      name: 'cost-accounts',
      period: { kind: 'month', month: '2026-09' },
      limit: 5,
      json: true,
    });
    expect(parse('ai-cost', 'account', ACCOUNT, '--day', '2026-10-01')).toEqual({
      name: 'cost-account',
      accountId: ACCOUNT,
      period: { kind: 'day', day: '2026-10-01' },
      json: false,
    });
  });

  it('scopes item and breakdown reports to one account when asked', () => {
    expect(parse('ai-cost', 'items', '--month', '2026-10')).toEqual({
      name: 'cost-items',
      period: { kind: 'month', month: '2026-10' },
      accountId: undefined,
      json: false,
    });
    expect(parse('ai-cost', 'breakdown', '--account', ACCOUNT.toUpperCase())).toEqual({
      name: 'cost-breakdown',
      period: { kind: 'day', day: '2026-10-24' },
      accountId: ACCOUNT,
      json: false,
    });
  });

  it('parses the spend check, the controls, and the audit trail', () => {
    expect(parse('ai-alerts', 'check')).toEqual({
      name: 'alerts-check',
      day: undefined,
      json: false,
    });
    expect(parse('ai-alerts', 'check', '--day', '2026-10-01', '--json')).toEqual({
      name: 'alerts-check',
      day: '2026-10-01',
      json: true,
    });
    expect(parse('ai-kill-switch', 'status')).toEqual({ name: 'kill-switch-status', json: false });
    expect(parse('ai-kill-switch', 'on', '--actor', 'alice', '--reason', 'spend spike')).toEqual({
      name: 'kill-switch-set',
      engaged: true,
      change: { actor: 'alice', reason: 'spend spike' },
    });
    expect(parse('ai-kill-switch', 'off', '--actor', 'bob', '--reason', 'resolved')).toMatchObject({
      engaged: false,
    });
    expect(parse('ai-block', 'list', '--json')).toEqual({ name: 'block-list', json: true });
    expect(parse('ai-block', 'on', ACCOUNT, '--actor', 'alice', '--reason', 'abuse')).toEqual({
      name: 'block-set',
      accountId: ACCOUNT,
      blocked: true,
      change: { actor: 'alice', reason: 'abuse' },
    });
    expect(parse('test-mode-access', 'list')).toEqual({
      name: 'test-mode-access-list',
      json: false,
    });
    expect(
      parse('test-mode-access', 'grant', '--account', ACCOUNT, '--actor', 'a', '--reason', 'r'),
    ).toEqual({
      name: 'test-mode-access-set',
      accountId: ACCOUNT,
      granted: true,
      change: { actor: 'a', reason: 'r' },
    });
    expect(
      parse('test-mode-access', 'revoke', '--account', ACCOUNT, '--actor', 'a', '--reason', 'r'),
    ).toMatchObject({ granted: false });
    expect(parse('account-find', '--shop', '@Some_Shop', '--json')).toEqual({
      name: 'account-find',
      shop: 'Some_Shop',
      json: true,
    });
    expect(parse('ai-audit')).toEqual({
      name: 'audit',
      accountId: undefined,
      limit: 50,
      json: false,
    });
    expect(parse('ai-audit', '--account', ACCOUNT, '--limit', '3')).toMatchObject({
      accountId: ACCOUNT,
      limit: 3,
    });
  });

  it('parses a marketplace purge, a dry run unless confirmed', () => {
    expect(
      parse('marketplace-purge', 'depop', '--mode', 'api', '--actor', 'alice', '--reason', 'ended'),
    ).toEqual({
      name: 'marketplace-purge',
      marketplace: 'depop',
      mode: 'api',
      change: { actor: 'alice', reason: 'ended' },
      confirm: false,
    });
    expect(
      parse(
        'marketplace-purge',
        'depop',
        '--mode',
        'api',
        '--actor',
        'a',
        '--reason',
        'r',
        '--confirm',
      ),
    ).toMatchObject({ confirm: true });
  });

  it('shows help for --help anywhere', () => {
    expect(parse('--help')).toEqual({ name: 'help' });
    expect(parse('ai-cost', 'accounts', '--help')).toEqual({ name: 'help' });
  });

  it.each([
    [[], 'missing command'],
    [['ai-spend'], 'unknown command "ai-spend"'],
    [['ai-cost'], 'ai-cost needs a report'],
    [['ai-cost', 'top'], 'unknown report "ai-cost top"'],
    [
      ['ai-cost', 'accounts', '--day', '2026-10-01', '--month', '2026-10'],
      'give either --day or --month, not both',
    ],
    [
      ['ai-cost', 'accounts', '--day', '2026-02-30'],
      'day must be a calendar date as YYYY-MM-DD, got 2026-02-30',
    ],
    [['ai-cost', 'accounts', '--month', '2026-13'], 'month must be YYYY-MM, got 2026-13'],
    [['ai-cost', 'accounts', '--limit', '0'], '--limit must be an integer from 1 to 1000'],
    [['ai-cost', 'accounts', '--limit', '1001'], '--limit must be an integer from 1 to 1000'],
    [['ai-cost', 'accounts', '--account', ACCOUNT], 'ai-cost accounts does not take --account'],
    [['ai-cost', 'accounts', 'extra'], 'ai-cost accounts takes no arguments, got extra'],
    [['ai-cost', 'account'], 'ai-cost account needs an account id'],
    [['ai-cost', 'account', 'not-a-uuid'], 'account id must be a UUID, got not-a-uuid'],
    [['ai-alerts'], 'ai-alerts needs check'],
    [['ai-alerts', 'check', '--month', '2026-10'], 'ai-alerts check does not take --month'],
    [['ai-kill-switch'], 'ai-kill-switch needs status, on, or off'],
    [['ai-kill-switch', 'on'], '--actor is required: who is making this change'],
    [
      ['ai-kill-switch', 'on', '--actor', 'alice'],
      '--reason is required: why this change is being made',
    ],
    [
      ['ai-kill-switch', 'on', '--actor', ' ', '--reason', 'x'],
      '--actor is required: who is making this change',
    ],
    [
      ['ai-kill-switch', 'status', '--actor', 'alice'],
      'ai-kill-switch status does not take --actor',
    ],
    [['ai-block', 'on', '--actor', 'a', '--reason', 'r'], 'ai-block on needs an account id'],
    [['ai-block', 'pause', ACCOUNT], 'ai-block pause needs list, on, or off'],
    [['ai-audit', 'all'], 'ai-audit takes no arguments, got all'],
    [['test-mode-access'], 'test-mode-access needs list, grant, or revoke'],
    [['test-mode-access', 'grant', '--actor', 'a', '--reason', 'r'], '--account is required'],
    [['test-mode-access', 'grant', '--account', ACCOUNT], '--actor is required'],
    [['test-mode-access', 'grant', ACCOUNT], 'test-mode-access grant takes no arguments'],
    [['test-mode-access', 'list', '--account', ACCOUNT], 'does not take --account'],
    [['account-find'], '--shop is required'],
    [['ai-cost', 'accounts', '--verbose'], "Unknown option '--verbose'"],
    [['marketplace-purge'], 'marketplace-purge needs a marketplace'],
    [['marketplace-purge', 'etsy', '--mode', 'api'], 'marketplace must be one of ebay, depop'],
    [['marketplace-purge', 'depop'], '--mode is required: api or automation'],
    [['marketplace-purge', 'depop', '--mode', 'api'], '--actor is required'],
    [['marketplace-purge', 'depop', '--json'], 'marketplace-purge does not take --json'],
    [['activity', '--item', ACCOUNT, '--sale', ACCOUNT], 'give at most one of'],
    [['activity', '--sku', 'AJ-000001'], '--sku needs --account'],
    [['activity', '--since', 'yesterday'], '--since must be an ISO 8601 time'],
    [['activity', '--marketplace', 'etsy'], '--marketplace must be one of'],
    [['sale-why'], 'sale id must be a UUID'],
    [['sale-history', 'read', 'mercari'], 'sale-history read needs --account'],
    [['sale-history', 'delete', 'mercari'], 'sale-history needs read or show'],
    [['sale-history', 'read', 'mercari', '--account', ACCOUNT, '--json'], 'does not take --json'],
  ])('rejects %j', (argv, message) => {
    expect(usageError(...argv)).toContain(message);
  });
});
