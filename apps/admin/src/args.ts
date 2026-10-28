import { parseArgs } from 'node:util';

import { parseUtcDay, usagePeriodRange, type AiControlChange, type UsagePeriod } from '@listora/ai';
import { MARKETPLACES, type Marketplace } from '@listora/db';

export const USAGE = `Usage: npm run admin -- <command> [options]

AI cost reports (UTC; the default period is today):
  ai-cost accounts [--day D | --month M] [--limit N]   top accounts by AI spend (default 20)
  ai-cost account <account-id> [--day D | --month M]   one account's AI usage
  ai-cost items [--day D | --month M] [--account ID]   AI cost per item worked on
  ai-cost breakdown [--day D | --month M] [--account ID]
                                                       AI spend by purpose, tier, and model

AI spend alerts:
  ai-alerts check [--day D]
                       run the spend check once: accounts near or over the daily budget or a
                       plan quota, and the global daily threshold (logs JSON lines to stderr)

AI controls (every change is recorded in the audit trail):
  ai-kill-switch status
  ai-kill-switch on|off --actor <name> --reason <text>
  ai-block list
  ai-block on|off <account-id> --actor <name> --reason <text>
  ai-audit [--account ID] [--limit N]                  the audit trail, newest first (default 50)

Marketplace data (docs/features/privacy.md):
  marketplace-purge <marketplace> --mode api|automation --actor <name> --reason <text> [--confirm]
                       delete the data of every connection to the marketplace in that mode, in
                       every account, as when the marketplace ends Listora's access (for example
                       Depop's partner API); without --confirm it only counts them

Marketplace operations (docs/features/operations.md):
  operation-try-now <operation-id> --account <account-id> --actor <name>
                       run a waiting operation's next attempt now instead of at its scheduled
                       time (retrying or verifying only; recorded in its history)

Activity and sale detection (docs/features/activity.md):
  activity [--account ID] [--item ID | --sku SKU | --operation ID | --sale ID]
           [--marketplace M] [--since T] [--until T] [--limit N]
                       one timeline, newest first (default 50): operation steps, browser
                       sessions with their steps and times, sale checks, orders, sales, delists,
                       tasks, and item changes; --sku needs --account
  sale-why <sale-id>   how a sale was found (which check saw it, where, when) and each delist it
                       started on the other marketplaces, with the sale's timeline
  sale-checks [--account ID] [--marketplace M] [--limit N]
                       each automation connection's sale-check health (and whether it is read
                       only), then the latest checks (default 20): what each read, how many
                       sold orders it saw, why it failed
  sale-history read <marketplace> --account ID
                       ask for a read-only read of the seller's sold history: it records every
                       sold order the pages show and hands none to the sale intake, so nothing
                       is delisted or changed (it runs where the connection runs: the phone or
                       the cloud browser)
  sale-history show <marketplace> --account ID
                       the newest history read and every sold order it saw

Background read health (docs/features/read-health.md):
  read-health [--account ID] [--marketplace M]
                       every automation connection's sale checks, listing imports, and offer
                       checks: when each last worked, how many failed in a row since, the last
                       error's code, step, and words, and when the owner was emailed

Test mode (docs/features/test-mode.md):
  feature-tests [--account ID] [--marketplace M] [--limit N]
                       the owner's log: each run of a feature not verified live, in an
                       account's Test mode, newest first, with its outcome and error

Options:
  --day YYYY-MM-DD    a UTC day
  --since, --until    a time (ISO 8601, for example 2026-10-26T18:00:00Z); --until excludes it
  --month YYYY-MM     a UTC calendar month
  --json              print the result as JSON
  --help              show this message
`;

/** A usage mistake: the CLI prints the message and the usage, and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type Command =
  | { readonly name: 'help' }
  | {
      readonly name: 'cost-accounts';
      readonly period: UsagePeriod;
      readonly limit: number;
      readonly json: boolean;
    }
  | {
      readonly name: 'cost-account';
      readonly accountId: string;
      readonly period: UsagePeriod;
      readonly json: boolean;
    }
  | {
      readonly name: 'cost-items' | 'cost-breakdown';
      readonly period: UsagePeriod;
      readonly accountId: string | undefined;
      readonly json: boolean;
    }
  | {
      readonly name: 'alerts-check';
      /** Today (UTC, database clock) when undefined. */
      readonly day: string | undefined;
      readonly json: boolean;
    }
  | { readonly name: 'kill-switch-status'; readonly json: boolean }
  | {
      readonly name: 'kill-switch-set';
      readonly engaged: boolean;
      readonly change: AiControlChange;
    }
  | { readonly name: 'block-list'; readonly json: boolean }
  | {
      readonly name: 'block-set';
      readonly accountId: string;
      readonly blocked: boolean;
      readonly change: AiControlChange;
    }
  | {
      readonly name: 'audit';
      readonly accountId: string | undefined;
      readonly limit: number;
      readonly json: boolean;
    }
  | {
      readonly name: 'activity';
      readonly filter: {
        readonly accountId?: string;
        readonly itemId?: string;
        readonly sku?: string;
        readonly operationId?: string;
        readonly saleId?: string;
        readonly marketplace?: Marketplace;
        readonly from?: Date;
        readonly to?: Date;
      };
      readonly limit: number;
      readonly json: boolean;
    }
  | { readonly name: 'sale-why'; readonly saleId: string; readonly json: boolean }
  | {
      readonly name: 'sale-checks';
      readonly accountId: string | undefined;
      readonly marketplace: Marketplace | undefined;
      readonly limit: number;
      readonly json: boolean;
    }
  | {
      readonly name: 'read-health';
      readonly accountId: string | undefined;
      readonly marketplace: Marketplace | undefined;
      readonly json: boolean;
    }
  | {
      readonly name: 'feature-tests';
      readonly accountId: string | undefined;
      readonly marketplace: Marketplace | undefined;
      readonly limit: number;
      readonly json: boolean;
    }
  | {
      readonly name: 'sale-history-read' | 'sale-history-show';
      readonly accountId: string;
      readonly marketplace: Marketplace;
      readonly json: boolean;
    }
  | {
      readonly name: 'marketplace-purge';
      readonly marketplace: Marketplace;
      readonly mode: 'api' | 'automation';
      /** Who ran it and why, for the log line (the same as an AI control change's). */
      readonly change: { readonly actor: string; readonly reason: string };
      readonly confirm: boolean;
    }
  | {
      readonly name: 'operation-try-now';
      readonly accountId: string;
      readonly operationId: string;
      readonly actor: string;
    };

const OPTIONS = {
  day: { type: 'string' },
  month: { type: 'string' },
  limit: { type: 'string' },
  account: { type: 'string' },
  actor: { type: 'string' },
  reason: { type: 'string' },
  mode: { type: 'string' },
  item: { type: 'string' },
  sku: { type: 'string' },
  operation: { type: 'string' },
  sale: { type: 'string' },
  marketplace: { type: 'string' },
  since: { type: 'string' },
  until: { type: 'string' },
  confirm: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;
type OptionName = keyof typeof OPTIONS;
type Values = Partial<Record<OptionName, string | boolean>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 1_000;

/**
 * Parses the command line into a command. `now` gives the default period, today in UTC.
 * Throws `UsageError` on anything it does not understand, including options a command does
 * not take, so a typo never runs a different report than the operator asked for.
 */
export function parseCommand(argv: readonly string[], now: Date = new Date()): Command {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { name: 'help' };
  const [group, action, ...rest] = positionals;
  const command = `${group ?? ''} ${action ?? ''}`.trim();

  switch (group) {
    case 'ai-cost':
      return parseCost(action, rest, values, now);
    case 'ai-alerts': {
      if (action !== 'check') throw new UsageError(`${command} needs check`);
      expectArgs(command, rest, 0);
      allowOnly(command, values, ['day', 'json']);
      const day = typeof values.day === 'string' ? parsePeriod(values, now) : undefined;
      return {
        name: 'alerts-check',
        day: day?.kind === 'day' ? day.day : undefined,
        json: values.json === true,
      };
    }
    case 'ai-kill-switch':
      return parseKillSwitch(action, rest, values);
    case 'ai-block':
      return parseBlock(action, rest, values);
    case 'ai-audit':
      expectArgs('ai-audit', action === undefined ? rest : [action, ...rest], 0);
      allowOnly('ai-audit', values, ['account', 'limit', 'json']);
      return {
        name: 'audit',
        accountId: optionalAccount(values),
        limit: parseLimit(values, 50),
        json: values.json === true,
      };
    case 'marketplace-purge': {
      expectArgs(
        'marketplace-purge',
        action === undefined ? rest : [action, ...rest],
        1,
        'a marketplace',
      );
      allowOnly('marketplace-purge', values, ['mode', 'actor', 'reason', 'confirm']);
      if (!(MARKETPLACES as readonly string[]).includes(action ?? '')) {
        throw new UsageError(`marketplace must be one of ${MARKETPLACES.join(', ')}`);
      }
      if (values.mode !== 'api' && values.mode !== 'automation') {
        throw new UsageError('--mode is required: api or automation');
      }
      return {
        name: 'marketplace-purge',
        marketplace: action as Marketplace,
        mode: values.mode,
        change: parseChange(values),
        confirm: values.confirm === true,
      };
    }
    case 'operation-try-now': {
      expectArgs(
        'operation-try-now',
        action === undefined ? rest : [action, ...rest],
        1,
        'an operation id',
      );
      allowOnly('operation-try-now', values, ['account', 'actor']);
      const account = optionalAccount(values);
      if (account === undefined) throw new UsageError('--account is required');
      if (!UUID.test(action ?? '')) throw new UsageError('the operation id must be a UUID');
      const actor = typeof values.actor === 'string' ? values.actor.trim() : '';
      if (actor === '') throw new UsageError('--actor is required');
      return {
        name: 'operation-try-now',
        accountId: account,
        operationId: (action ?? '').toLowerCase(),
        actor,
      };
    }
    case 'activity': {
      expectArgs('activity', action === undefined ? rest : [action, ...rest], 0);
      allowOnly('activity', values, [
        'account',
        'item',
        'sku',
        'operation',
        'sale',
        'marketplace',
        'since',
        'until',
        'limit',
        'json',
      ]);
      const scopes = (['item', 'sku', 'operation', 'sale'] as const).filter(
        (option) => typeof values[option] === 'string',
      );
      if (scopes.length > 1) {
        throw new UsageError('give at most one of --item, --sku, --operation, --sale');
      }
      const accountIdValue = optionalAccount(values);
      if (typeof values.sku === 'string' && accountIdValue === undefined) {
        throw new UsageError('--sku needs --account: SKUs are per account');
      }
      const marketplace = optionalMarketplace(values);
      const from = optionalTime(values, 'since');
      const to = optionalTime(values, 'until');
      return {
        name: 'activity',
        filter: {
          ...(accountIdValue === undefined ? {} : { accountId: accountIdValue }),
          ...(typeof values.item === 'string' ? { itemId: uuid('--item', values.item) } : {}),
          ...(typeof values.sku === 'string' ? { sku: values.sku.toUpperCase() } : {}),
          ...(typeof values.operation === 'string'
            ? { operationId: uuid('--operation', values.operation) }
            : {}),
          ...(typeof values.sale === 'string' ? { saleId: uuid('--sale', values.sale) } : {}),
          ...(marketplace === undefined ? {} : { marketplace }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        },
        limit: parseLimit(values, 50),
        json: values.json === true,
      };
    }
    case 'sale-why':
      expectArgs('sale-why', rest, 0);
      allowOnly('sale-why', values, ['json']);
      return {
        name: 'sale-why',
        saleId: uuid('sale id', action),
        json: values.json === true,
      };
    case 'sale-checks': {
      expectArgs('sale-checks', action === undefined ? rest : [action, ...rest], 0);
      allowOnly('sale-checks', values, ['account', 'marketplace', 'limit', 'json']);
      return {
        name: 'sale-checks',
        accountId: optionalAccount(values),
        marketplace: optionalMarketplace(values),
        limit: parseLimit(values, 20),
        json: values.json === true,
      };
    }
    case 'read-health': {
      expectArgs('read-health', action === undefined ? rest : [action, ...rest], 0);
      allowOnly('read-health', values, ['account', 'marketplace', 'json']);
      return {
        name: 'read-health',
        accountId: optionalAccount(values),
        marketplace: optionalMarketplace(values),
        json: values.json === true,
      };
    }
    case 'feature-tests': {
      expectArgs('feature-tests', action === undefined ? rest : [action, ...rest], 0);
      allowOnly('feature-tests', values, ['account', 'marketplace', 'limit', 'json']);
      return {
        name: 'feature-tests',
        accountId: optionalAccount(values),
        marketplace: optionalMarketplace(values),
        limit: parseLimit(values, 50),
        json: values.json === true,
      };
    }
    case 'sale-history': {
      if (action !== 'read' && action !== 'show') {
        throw new UsageError('sale-history needs read or show');
      }
      const command = `sale-history ${action}`;
      expectArgs(command, rest, 1, 'a marketplace');
      allowOnly(command, values, action === 'show' ? ['account', 'json'] : ['account']);
      const marketplace = rest[0];
      if (!(MARKETPLACES as readonly string[]).includes(marketplace ?? '')) {
        throw new UsageError(`marketplace must be one of ${MARKETPLACES.join(', ')}`);
      }
      if (typeof values.account !== 'string') throw new UsageError(`${command} needs --account`);
      return {
        name: action === 'read' ? 'sale-history-read' : 'sale-history-show',
        accountId: accountId(values.account),
        marketplace: marketplace as Marketplace,
        json: values.json === true,
      };
    }
    case undefined:
      throw new UsageError('missing command');
    default:
      throw new UsageError(`unknown command "${group}"`);
  }
}

function parseCost(
  action: string | undefined,
  rest: readonly string[],
  values: Values,
  now: Date,
): Command {
  const command = `ai-cost ${action ?? ''}`.trim();
  const json = values.json === true;
  switch (action) {
    case 'accounts':
      expectArgs(command, rest, 0);
      allowOnly(command, values, ['day', 'month', 'limit', 'json']);
      return {
        name: 'cost-accounts',
        period: parsePeriod(values, now),
        limit: parseLimit(values, 20),
        json,
      };
    case 'account':
      expectArgs(command, rest, 1);
      allowOnly(command, values, ['day', 'month', 'json']);
      return {
        name: 'cost-account',
        accountId: accountId(rest[0]),
        period: parsePeriod(values, now),
        json,
      };
    case 'items':
    case 'breakdown':
      expectArgs(command, rest, 0);
      allowOnly(command, values, ['day', 'month', 'account', 'json']);
      return {
        name: action === 'items' ? 'cost-items' : 'cost-breakdown',
        period: parsePeriod(values, now),
        accountId: optionalAccount(values),
        json,
      };
    case undefined:
    default:
      throw new UsageError(
        action === undefined ? 'ai-cost needs a report' : `unknown report "ai-cost ${action}"`,
      );
  }
}

function parseKillSwitch(
  action: string | undefined,
  rest: readonly string[],
  values: Values,
): Command {
  const command = `ai-kill-switch ${action ?? ''}`.trim();
  switch (action) {
    case 'status':
      expectArgs(command, rest, 0);
      allowOnly(command, values, ['json']);
      return { name: 'kill-switch-status', json: values.json === true };
    case 'on':
    case 'off':
      expectArgs(command, rest, 0);
      allowOnly(command, values, ['actor', 'reason']);
      return { name: 'kill-switch-set', engaged: action === 'on', change: parseChange(values) };
    case undefined:
    default:
      throw new UsageError(`${command} needs status, on, or off`);
  }
}

function parseBlock(action: string | undefined, rest: readonly string[], values: Values): Command {
  const command = `ai-block ${action ?? ''}`.trim();
  switch (action) {
    case 'list':
      expectArgs(command, rest, 0);
      allowOnly(command, values, ['json']);
      return { name: 'block-list', json: values.json === true };
    case 'on':
    case 'off':
      expectArgs(command, rest, 1);
      allowOnly(command, values, ['actor', 'reason']);
      return {
        name: 'block-set',
        accountId: accountId(rest[0]),
        blocked: action === 'on',
        change: parseChange(values),
      };
    case undefined:
    default:
      throw new UsageError(`${command} needs list, on, or off`);
  }
}

function parsePeriod(values: Values, now: Date): UsagePeriod {
  const { day, month } = values;
  if (typeof day === 'string' && typeof month === 'string') {
    throw new UsageError('give either --day or --month, not both');
  }
  try {
    if (typeof month === 'string') {
      const period = { kind: 'month', month } as const;
      usagePeriodRange(period);
      return period;
    }
    const period = {
      kind: 'day',
      day: typeof day === 'string' ? day : now.toISOString().slice(0, 10),
    } as const;
    parseUtcDay(period.day);
    return period;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function parseLimit(values: Values, fallback: number): number {
  if (typeof values.limit !== 'string') return fallback;
  const limit = Number(values.limit);
  if (!/^\d+$/.test(values.limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new UsageError(`--limit must be an integer from 1 to ${String(MAX_LIMIT)}`);
  }
  return limit;
}

function parseChange(values: Values): AiControlChange {
  const { actor, reason } = values;
  if (typeof actor !== 'string' || actor.trim() === '') {
    throw new UsageError('--actor is required: who is making this change');
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new UsageError('--reason is required: why this change is being made');
  }
  return { actor, reason };
}

function optionalAccount(values: Values): string | undefined {
  return typeof values.account === 'string' ? accountId(values.account) : undefined;
}

function optionalMarketplace(values: Values): Marketplace | undefined {
  const { marketplace } = values;
  if (typeof marketplace !== 'string') return undefined;
  if (!(MARKETPLACES as readonly string[]).includes(marketplace)) {
    throw new UsageError(`--marketplace must be one of ${MARKETPLACES.join(', ')}`);
  }
  return marketplace as Marketplace;
}

function optionalTime(values: Values, option: 'since' | 'until'): Date | undefined {
  const value = values[option];
  if (typeof value !== 'string') return undefined;
  const time = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(value) ||
    Number.isNaN(time.getTime())
  ) {
    throw new UsageError(`--${option} must be an ISO 8601 time, for example 2026-10-26T18:00:00Z`);
  }
  return time;
}

function uuid(what: string, value: string | undefined): string {
  if (value === undefined || !UUID.test(value)) {
    throw new UsageError(`${what} must be a UUID, got ${value ?? '(none)'}`);
  }
  return value.toLowerCase();
}

function accountId(value: string | undefined): string {
  if (value === undefined || !UUID.test(value)) {
    throw new UsageError(`account id must be a UUID, got ${value ?? '(none)'}`);
  }
  return value.toLowerCase();
}

function expectArgs(
  command: string,
  args: readonly (string | undefined)[],
  count: number,
  what = 'an account id',
): void {
  const given = args.filter((arg) => arg !== undefined);
  if (given.length !== count) {
    throw new UsageError(
      count === 0
        ? `${command} takes no arguments, got ${given.join(' ')}`
        : `${command} needs ${what}`,
    );
  }
}

function allowOnly(command: string, values: Values, allowed: readonly OptionName[]): void {
  for (const option of Object.keys(values) as OptionName[]) {
    if (!allowed.includes(option)) throw new UsageError(`${command} does not take --${option}`);
  }
}
