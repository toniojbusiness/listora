import {
  accountSpend,
  checkAiSpend,
  costPerItem,
  loadAiAlertConfig,
  PostgresAiControls,
  spendBreakdown,
  topAccountsBySpend,
  type AiControlChange,
  type AiSpendAlert,
} from '@listora/ai';
import type { AiControlAction, Db } from '@listora/db';
import { assertNever, type Logger } from '@listora/shared';

import { USAGE, type Command } from './args.ts';
import {
  describePeriod,
  formatCount,
  formatFields,
  formatMicros,
  formatQuantity,
  formatShare,
  formatTable,
} from './format.ts';

export interface CommandContext {
  readonly db: Db;
  /** Where the command's result goes (stdout). */
  readonly write: (text: string) => void;
  /** Structured operational events (stderr in the CLI). */
  readonly logger: Logger;
  /** For the spend check's thresholds. */
  readonly env: NodeJS.ProcessEnv;
}

/** A command failed for a reason the operator can act on; the CLI exits 1. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

/** Runs one parsed command and writes its result. */
export async function runCommand(command: Command, context: CommandContext): Promise<void> {
  const { db, write } = context;
  const print = (text: string) => {
    write(`${text}\n`);
  };
  const printJson = (value: unknown) => {
    print(JSON.stringify(value, null, 2));
  };
  const controls = new PostgresAiControls(db);

  switch (command.name) {
    case 'help':
      write(USAGE);
      return;

    case 'cost-accounts': {
      const report = await topAccountsBySpend(db, command.period, command.limit);
      if (command.json) {
        printJson(report);
        return;
      }
      const { total } = report;
      print(
        `AI spend for ${describePeriod(command.period)}: ${formatMicros(total.costMicros)}, ` +
          `${formatQuantity(total.calls, 'call')} (${formatCount(total.failedCalls)} failed), ` +
          formatQuantity(total.accounts, 'account'),
      );
      if (report.accounts.length === 0) {
        print('No AI usage in this period.');
        return;
      }
      print(
        `\n${formatTable(
          ['#', 'Account', 'Name', 'Cost', 'Calls', 'Failed', 'Share'],
          report.accounts.map((row, index) => [
            String(index + 1),
            row.accountId,
            row.accountName,
            formatMicros(row.costMicros),
            formatCount(row.calls),
            formatCount(row.failedCalls),
            formatShare(row.costMicros, total.costMicros),
          ]),
          [0, 3, 4, 5, 6],
        )}`,
      );
      return;
    }

    case 'cost-account': {
      const report = await accountSpend(db, command.accountId, command.period);
      if (report === undefined) throw new CommandError(`no account ${command.accountId}`);
      if (command.json) {
        printJson(report);
        return;
      }
      const { totals } = report;
      print(
        `AI usage of account ${report.accountId} (${report.accountName}) for ` +
          `${describePeriod(command.period)}\n\n` +
          formatFields([
            ['cost', formatMicros(totals.costMicros)],
            ['calls', `${formatCount(totals.calls)} (${formatCount(totals.failedCalls)} failed)`],
            ['input tokens', formatCount(totals.inputTokens)],
            ['output tokens', formatCount(totals.outputTokens)],
            ['cache read tokens', formatCount(totals.cacheReadTokens)],
            ['cache write tokens', formatCount(totals.cacheWriteTokens)],
            ['images', formatCount(totals.images)],
            ['web searches', formatCount(totals.webSearches)],
          ]),
      );
      return;
    }

    case 'cost-items': {
      const report = await costPerItem(
        db,
        command.period,
        command.accountId === undefined ? {} : { accountId: command.accountId },
      );
      if (command.json) {
        printJson(report);
        return;
      }
      print(
        `AI cost per item for ${describePeriod(command.period)}, ` +
          `${command.accountId === undefined ? 'all accounts' : `account ${command.accountId}`}\n\n` +
          formatFields([
            ['items worked on', formatCount(report.items)],
            ['cost of those items', formatMicros(report.itemCostMicros)],
            [
              'average per item',
              report.averageItemCostMicros === null
                ? '-'
                : formatMicros(report.averageItemCostMicros),
            ],
            ['highest item', formatMicros(report.maxItemCostMicros)],
            [
              'calls without an item',
              `${formatCount(report.unattributedCalls)} (${formatMicros(report.unattributedCostMicros)})`,
            ],
          ]),
      );
      return;
    }

    case 'cost-breakdown': {
      const rows = await spendBreakdown(
        db,
        command.period,
        command.accountId === undefined ? {} : { accountId: command.accountId },
      );
      if (command.json) {
        printJson({ period: command.period, rows });
        return;
      }
      const total = rows.reduce((sum, row) => sum + row.costMicros, 0);
      print(
        `AI spend by purpose and model for ${describePeriod(command.period)}, ` +
          `${command.accountId === undefined ? 'all accounts' : `account ${command.accountId}`}: ` +
          formatMicros(total),
      );
      if (rows.length === 0) {
        print('No AI usage in this period.');
        return;
      }
      print(
        `\n${formatTable(
          [
            'Purpose',
            'Tier',
            'Model',
            'Calls',
            'Failed',
            'Cost',
            'Share',
            'Input tok',
            'Output tok',
          ],
          rows.map((row) => [
            row.purpose,
            row.tier,
            row.model,
            formatCount(row.calls),
            formatCount(row.failedCalls),
            formatMicros(row.costMicros),
            formatShare(row.costMicros, total),
            formatCount(row.inputTokens),
            formatCount(row.outputTokens),
          ]),
          [3, 4, 5, 6, 7, 8],
        )}`,
      );
      return;
    }

    case 'alerts-check': {
      const thresholds = loadAiAlertConfig(context.env);
      const check = await checkAiSpend(db, thresholds, {
        logger: context.logger,
        ...(command.day === undefined ? {} : { day: command.day }),
      });
      if (command.json) {
        printJson({ ...check, thresholds });
        return;
      }
      print(
        `AI spend check for ${check.day} (UTC): ${formatMicros(check.globalSpentMicros)} spent ` +
          `of the ${formatMicros(thresholds.globalDailyAlertMicros)} global alert threshold; ` +
          `per-account daily budget ${formatMicros(thresholds.dailyBudgetMicros)}, ` +
          `warning from ${String(thresholds.warnPercent)}%`,
      );
      print(
        `kill switch ${check.killSwitchEngaged ? 'ON' : 'off'}, ` +
          formatQuantity(check.blockedAccounts, 'blocked account'),
      );
      if (check.alerts.length === 0) {
        print('No alerts.');
        return;
      }
      print(
        `\n${formatTable(
          ['Severity', 'Alert', 'Account', 'Detail'],
          check.alerts.map((alert) => [
            alert.severity.toUpperCase(),
            alert.kind,
            alert.kind === 'global_daily_spend' ? '-' : alert.accountId,
            alertDetail(alert),
          ]),
        )}`,
      );
      return;
    }

    case 'kill-switch-status': {
      const state = await controls.killSwitch();
      const blocked = await controls.blockedAccounts();
      if (command.json) {
        printJson({ ...state, blockedAccounts: blocked.length });
        return;
      }
      print(
        `AI kill switch: ${state.engaged ? 'ON - every AI call is refused' : 'off'}` +
          (state.lastChange === null
            ? ' (never changed)'
            : ` (set by ${state.lastChange.actor} at ${state.lastChange.at.toISOString()}: ` +
              `${state.lastChange.reason})`),
      );
      print(`${formatQuantity(blocked.length, 'account')} blocked from AI (ai-block list)`);
      print('AI_KILL_SWITCH=on in a process environment also refuses that process every AI call.');
      return;
    }

    case 'kill-switch-set': {
      const { changed } = await controls.setKillSwitch(command.engaged, command.change);
      const state = command.engaged ? 'on' : 'off';
      logChange(
        context.logger,
        changed,
        command.engaged ? 'kill_switch_on' : 'kill_switch_off',
        command.change,
      );
      print(
        changed
          ? `AI kill switch is now ${state}.`
          : `AI kill switch was already ${state}; nothing changed.`,
      );
      return;
    }

    case 'block-list': {
      const blocks = await controls.blockedAccounts();
      if (command.json) {
        printJson(blocks);
        return;
      }
      if (blocks.length === 0) {
        print('No account is blocked from AI.');
        return;
      }
      print(
        formatTable(
          ['Account', 'Name', 'Blocked at', 'By', 'Reason'],
          blocks.map((block) => [
            block.accountId,
            block.accountName,
            block.blockedAt.toISOString(),
            block.blockedBy,
            block.reason,
          ]),
        ),
      );
      return;
    }

    case 'block-set': {
      const { changed } = command.blocked
        ? await controls.blockAccount(command.accountId, command.change)
        : await controls.unblockAccount(command.accountId, command.change);
      logChange(
        context.logger,
        changed,
        command.blocked ? 'account_block_on' : 'account_block_off',
        command.change,
        command.accountId,
      );
      const account = `Account ${command.accountId}`;
      if (command.blocked) {
        print(
          changed
            ? `${account} is now blocked from AI.`
            : `${account} was already blocked from AI; nothing changed.`,
        );
      } else {
        print(
          changed
            ? `${account} is no longer blocked from AI.`
            : `${account} was not blocked from AI; nothing changed.`,
        );
      }
      return;
    }

    case 'audit': {
      const entries = await controls.auditTrail({
        limit: command.limit,
        ...(command.accountId === undefined ? {} : { accountId: command.accountId }),
      });
      if (command.json) {
        printJson(entries);
        return;
      }
      if (entries.length === 0) {
        print('No AI control changes recorded.');
        return;
      }
      print(
        formatTable(
          ['Time', 'Action', 'Account', 'Actor', 'Reason'],
          entries.map((entry) => [
            entry.createdAt.toISOString(),
            entry.action,
            entry.accountId ?? '-',
            entry.actor,
            entry.reason,
          ]),
        ),
      );
      return;
    }

    default:
      assertNever(command);
  }
}

function alertDetail(alert: AiSpendAlert): string {
  switch (alert.kind) {
    case 'account_daily_budget':
      return `${formatMicros(alert.spentMicros)} of ${formatMicros(alert.limitMicros)} today`;
    case 'account_quota':
      return (
        `${alert.metric} ${formatCount(alert.used)} of ${formatCount(alert.quota)}, ` +
        `resets ${alert.periodEnd}`
      );
    case 'global_daily_spend':
      return `${formatMicros(alert.spentMicros)} of ${formatMicros(alert.thresholdMicros)} today`;
  }
}

/** One line per control request, so log-based alarms can watch operator actions too. */
function logChange(
  logger: Logger,
  changed: boolean,
  action: AiControlAction,
  change: AiControlChange,
  accountId?: string,
): void {
  logger.info(
    { event: 'ai_control_changed', action, changed, accountId, actor: change.actor.trim() },
    changed ? 'AI control changed' : 'AI control already in the requested state',
  );
}
