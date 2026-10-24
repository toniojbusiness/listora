import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

export type LogLine = Record<string, unknown>;

export interface StartedProcess {
  /** Every JSON line the process has written to stdout so far. */
  readonly logs: readonly LogLine[];
  /** Resolves with the first log line matching `predicate`; rejects on exit or timeout. */
  waitForLog(predicate: (line: LogLine) => boolean, timeoutMs?: number): Promise<LogLine>;
  /** Sends `signal` and resolves with the exit code. */
  stop(signal?: NodeJS.Signals): Promise<number | null>;
}

/**
 * Starts a TypeScript entry point the way production does (`node <file>.ts`) and collects its
 * structured JSON logs, so tests prove the real process boots and shuts down.
 */
export function startNodeProcess(entry: string, env: NodeJS.ProcessEnv): StartedProcess {
  const child: ChildProcess = spawn(process.execPath, [entry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: LogLine[] = [];
  let stderr = '';
  const listeners = new Set<() => void>();

  if (!child.stdout || !child.stderr) throw new Error('child process has no stdio pipes');
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      logs.push(JSON.parse(line) as LogLine);
    } catch {
      logs.push({ msg: line, unstructured: true });
    }
    for (const listener of listeners) listener();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;

  return {
    logs,
    waitForLog(predicate, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const check = (): void => {
          const match = logs.find(predicate);
          if (match) {
            cleanup();
            resolve(match);
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timed out waiting for log line; stderr:\n${stderr}`));
        }, timeoutMs);
        const onExit = (): void => {
          cleanup();
          reject(new Error(`process exited before the expected log line; stderr:\n${stderr}`));
        };
        const cleanup = (): void => {
          clearTimeout(timer);
          listeners.delete(check);
          child.off('exit', onExit);
        };
        listeners.add(check);
        child.once('exit', onExit);
        check();
      });
    },
    async stop(signal = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      const [code] = await exited;
      return code;
    },
  };
}
