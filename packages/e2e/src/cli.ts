import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { stackEnvironment, startLocalStack } from './stack.ts';

const USAGE = `Usage: npm run e2e:stack -- --fake-ai-fixtures <dir> [--log-dir <dir>] [-- <command> [args...]]

Starts the local stack (API and worker with fakes, a scratch database, a signed-in user).
With a command, runs it with the stack's settings in its environment and stops the stack when
it exits, exiting with its code. Without one, prints the settings and runs until interrupted.`;

async function main(argv: readonly string[]): Promise<number> {
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  let values: { 'fake-ai-fixtures'?: string; 'log-dir'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...own],
      options: {
        'fake-ai-fixtures': { type: 'string' },
        'log-dir': { type: 'string' },
        help: { type: 'boolean' },
      },
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const fixtures = values['fake-ai-fixtures'];
  if (fixtures === undefined) {
    process.stderr.write(`--fake-ai-fixtures is required\n\n${USAGE}\n`);
    return 2;
  }

  // `npm run` starts this in the workspace's directory; paths are the caller's.
  const base = process.env['INIT_CWD'] ?? process.cwd();
  const logDir = values['log-dir'];
  const stack = await startLocalStack({
    fakeAiFixturesDir: resolve(base, fixtures),
    ...(logDir === undefined ? {} : { logDir: resolve(base, logDir) }),
  });
  process.stdout.write(`e2e stack: API at ${stack.apiUrl}, signed in as ${stack.email}\n`);
  try {
    if (command.length === 0) {
      for (const [name, value] of Object.entries(stackEnvironment(stack))) {
        if (!name.startsWith('TEST_RUNNER_')) process.stdout.write(`${name}=${value}\n`);
      }
      process.stdout.write('Press Ctrl-C to stop.\n');
      await new Promise<void>((done) => {
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
      });
      return 0;
    }
    return await run(command, { ...process.env, ...stackEnvironment(stack) });
  } finally {
    await stack.stop();
  }
}

/** Runs a command with inherited output; an interrupt reaches it, then the stack stops. */
async function run(command: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [file, ...args] = command;
  if (file === undefined) return 2;
  const child = spawn(file, args, { env, stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  try {
    return await new Promise<number>((done, fail) => {
      child.once('error', fail);
      child.once('exit', (code, signal) => {
        // A command killed by a signal exits as a shell reports it: 128 + the signal number.
        done(code ?? 128 + (signal === null ? 0 : constants.signals[signal]));
      });
    });
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `e2e stack failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
