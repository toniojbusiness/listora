import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

export type LogLine = Record<string, unknown>;

export interface StartedProcess {
  /** Every JSON line the process has written to stdout so far. */
  readonly logs: readonly LogLine[];
  /** Everything the process has written to stderr so far. */
  readonly stderr: string;
  /** Resolves with the first log line matching `predicate`; rejects on exit or timeout. */
  waitForLog(predicate: (line: LogLine) => boolean, timeoutMs?: number): Promise<LogLine>;
  /** Resolves with the exit code once the process exits on its own; rejects on timeout. */
  waitForExit(timeoutMs?: number): Promise<number | null>;
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
  let closed = false;
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

  const exited = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
  void exited.then(
    () => {
      closed = true;
    },
    () => undefined,
  );

  return {
    logs,
    get stderr() {
      return stderr;
    },
    waitForLog(predicate, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const check = (): boolean => {
          const match = logs.find(predicate);
          if (match) {
            cleanup();
            resolve(match);
          }
          return match !== undefined;
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timed out waiting for log line; stderr:\n${stderr}`));
        }, timeoutMs);
        const onClose = (): void => {
          if (check()) return;
          cleanup();
          reject(new Error(`process exited before the expected log line; stderr:\n${stderr}`));
        };
        const cleanup = (): void => {
          clearTimeout(timer);
          listeners.delete(check);
          child.off('close', onClose);
        };
        if (check()) return;
        if (closed) {
          onClose();
          return;
        }
        listeners.add(check);
        child.once('close', onClose);
      });
    },
    async waitForExit(timeoutMs = 10_000) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`process did not exit within ${String(timeoutMs)} ms; stderr:\n${stderr}`),
          );
        }, timeoutMs);
      });
      try {
        const [code] = await Promise.race([exited, timeout]);
        return code;
      } finally {
        clearTimeout(timer);
      }
    },
    async stop(signal = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      const [code] = await exited;
      return code;
    },
  };
}
