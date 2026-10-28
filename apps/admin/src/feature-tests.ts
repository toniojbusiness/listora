/**
 * The owner's log of Test mode (docs/features/test-mode.md): each run of a marketplace feature
 * that has not passed live, in the account's Test mode, newest first, with its outcome and its
 * error. A passed run here is the evidence cited when the feature is marked verified, which
 * still takes a reviewed change to `VERIFIED_FEATURES`.
 */
import { MARKETPLACE_NAMES } from '@listora/marketplaces';

import type { Command } from './args.ts';
import type { CommandContext } from './commands.ts';
import { formatTable } from './format.ts';

type FeatureTestsCommand = Extract<Command, { name: 'feature-tests' }>;

export async function runFeatureTestsCommand(
  command: FeatureTestsCommand,
  context: CommandContext,
): Promise<void> {
  const { db, write } = context;
  const runs = await db
    .selectFrom('feature_test_run')
    .selectAll()
    .$if(command.accountId !== undefined, (q) =>
      q.where('account_id', '=', command.accountId ?? ''),
    )
    .$if(command.marketplace !== undefined, (q) =>
      q.where('marketplace', '=', command.marketplace ?? 'ebay'),
    )
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(command.limit)
    .execute();

  if (command.json) {
    write(
      `${JSON.stringify(
        runs.map((run) => ({
          id: run.id,
          accountId: run.account_id,
          marketplace: run.marketplace,
          feature: run.feature,
          outcome: run.outcome,
          subjectId: run.subject_id,
          errorCode: run.error_code,
          detail: run.detail,
          at: run.created_at,
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (runs.length === 0) {
    write('No Test mode run.\n');
    return;
  }
  write(
    `${formatTable(
      ['At', 'Account', 'Marketplace', 'Feature', 'Outcome', 'Subject', 'Error'],
      runs.map((run) => [
        run.created_at.toISOString(),
        run.account_id,
        MARKETPLACE_NAMES[run.marketplace],
        run.feature,
        run.outcome,
        run.subject_id,
        run.error_code === null ? '-' : `${run.error_code}: ${run.detail ?? ''}`.trim(),
      ]),
    )}\n`,
  );
}
