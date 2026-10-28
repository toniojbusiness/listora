/**
 * The owner's view of background read health (docs/features/read-health.md): every automation
 * connection's sale checks, listing imports, and offer checks, with when each last worked, its
 * run of failures, the last error (code, step, the reader's words), and when the owner was
 * emailed about it. A read a connection never ran shows as never run.
 */
import { READ_NAMES, readFailureReason } from '@listora/automation';
import { BACKGROUND_READS, type BackgroundRead } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';

import type { Command } from './args.ts';
import type { CommandContext } from './commands.ts';
import { formatTable } from './format.ts';

type ReadHealthCommand = Extract<Command, { name: 'read-health' }>;

export async function runReadHealthCommand(
  command: ReadHealthCommand,
  context: CommandContext,
): Promise<void> {
  const { db, write } = context;
  const connections = await db
    .selectFrom('marketplace_connection')
    .select(['account_id', 'id', 'marketplace', 'status', 'runs_on', 'read_only'])
    .where('mode', '=', 'automation')
    .$if(command.accountId !== undefined, (q) =>
      q.where('account_id', '=', command.accountId ?? ''),
    )
    .$if(command.marketplace !== undefined, (q) =>
      q.where('marketplace', '=', command.marketplace ?? 'ebay'),
    )
    .orderBy('account_id')
    .orderBy('marketplace')
    .execute();
  const health = await db
    .selectFrom('background_read_health')
    .selectAll()
    .$if(command.accountId !== undefined, (q) =>
      q.where('account_id', '=', command.accountId ?? ''),
    )
    .$if(command.marketplace !== undefined, (q) =>
      q.where('marketplace', '=', command.marketplace ?? 'ebay'),
    )
    .execute();
  const byKey = new Map(health.map((row) => [`${row.connection_id}:${row.read}`, row]));
  const rows = connections.flatMap((connection) =>
    BACKGROUND_READS.map((read: BackgroundRead) => ({
      connection,
      read,
      health: byKey.get(`${connection.id}:${read}`),
    })),
  );

  if (command.json) {
    write(
      `${JSON.stringify(
        rows.map(({ connection, read, health: row }) => ({
          accountId: connection.account_id,
          connectionId: connection.id,
          marketplace: connection.marketplace,
          status: connection.status,
          runsOn: connection.runs_on,
          readOnly: connection.read_only,
          read,
          lastSucceededAt: row?.last_succeeded_at ?? null,
          lastFailedAt: row?.last_failed_at ?? null,
          failuresInARow: row?.failures_in_a_row ?? 0,
          failingSince: row?.failing_since ?? null,
          lastErrorCode: row?.last_error_code ?? null,
          lastErrorStep: row?.last_error_step ?? null,
          lastErrorDetail: row?.last_error_detail ?? null,
          ownerAlertedAt: row?.owner_alerted_at ?? null,
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (connections.length === 0) {
    write('No automation connection.\n');
    return;
  }
  write(
    `${formatTable(
      [
        'Account',
        'Marketplace',
        'Connection',
        'Status',
        'Runs on',
        'Read',
        'Last worked',
        'Failed in a row',
        'Failing since',
        'Owner emailed',
        'Last error',
      ],
      rows.map(({ connection, read, health: row }) => [
        connection.account_id,
        MARKETPLACE_NAMES[connection.marketplace],
        connection.id,
        connection.read_only ? `${connection.status}, read only` : connection.status,
        connection.runs_on,
        READ_NAMES[read],
        row === undefined ? 'never ran' : (row.last_succeeded_at?.toISOString() ?? 'never'),
        String(row?.failures_in_a_row ?? 0),
        row?.failing_since?.toISOString() ?? '-',
        row?.owner_alerted_at?.toISOString() ?? '-',
        lastError(row),
      ]),
      [7],
    )}\n`,
  );
}

function lastError(
  row:
    | {
        last_error_code: string | null;
        last_error_step: string | null;
        last_error_detail: string | null;
      }
    | undefined,
): string {
  if (row?.last_error_code === undefined || row.last_error_code === null) return '-';
  const step = row.last_error_step === null ? '' : ` at "${row.last_error_step}"`;
  const words = row.last_error_detail ?? readFailureReason(row.last_error_code);
  return `${row.last_error_code}${step}: ${words}`;
}
