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

Options:
  --day YYYY-MM-DD    a UTC day
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
      readonly name: 'marketplace-purge';
      readonly marketplace: Marketplace;
      readonly mode: 'api' | 'automation';
      /** Who ran it and why, for the log line (the same as an AI control change's). */
      readonly change: { readonly actor: string; readonly reason: string };
      readonly confirm: boolean;
    };

const OPTIONS = {
  day: { type: 'string' },
  month: { type: 'string' },
  limit: { type: 'string' },
  account: { type: 'string' },
  actor: { type: 'string' },
  reason: { type: 'string' },
  mode: { type: 'string' },
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
