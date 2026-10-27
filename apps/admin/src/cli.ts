// Operator CLI: AI cost reports, the AI spend check, the AI kill switch and account blocks,
// marketplace data purges, and the activity search and sale-check health
// (docs/features/activity.md). `npm run admin -- --help` lists the commands. Reads DATABASE_URL and the AI alert
// settings from the environment (see `.env.example`). Results go to stdout; structured
// operational events (spend alerts, control changes) go to stderr as JSON lines.
//
// Exit codes: 0 done (including a change that was already in effect), 1 failed, 2 usage error.
import { AiConfigError, AiControlError } from '@listora/ai';
import { createDatabase } from '@listora/db';
import { createLogger } from '@listora/shared';

import { parseCommand, USAGE, UsageError } from './args.ts';
import { CommandError, runCommand } from './commands.ts';
import { ConfigError, loadAdminConfig } from './config.ts';

async function main(argv: readonly string[]): Promise<number> {
  const command = parseCommand(argv);
  if (command.name === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const config = loadAdminConfig();
  const logger = createLogger({
    service: 'admin',
    level: config.logLevel,
    destination: process.stderr,
  });
  const db = createDatabase({ connectionString: config.databaseUrl, max: 2 });
  try {
    await runCommand(command, {
      db,
      write: (text) => process.stdout.write(text),
      logger,
      env: process.env,
    });
    return 0;
  } finally {
    await db.destroy();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`admin: ${message}\n`);
  if (error instanceof UsageError) {
    process.stderr.write(`\n${USAGE}`);
    process.exitCode = 2;
  } else {
    // Expected failures print their message; anything else also prints its stack.
    const expected = [CommandError, AiControlError, AiConfigError, ConfigError].some(
      (type) => error instanceof type,
    );
    if (!expected && error instanceof Error && error.stack !== undefined) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = 1;
  }
}
