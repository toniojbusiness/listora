import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';

/**
 * Ports handed out here sit below every ephemeral range the tests run on (Linux starts at 32768,
 * macOS at 49152), so the operating system never gives one to a `listen(0)` server or to an
 * outgoing connection's local end, as it could with a port a probe got from `listen(0)`.
 */
const FIRST_PORT = 20_000;
const LAST_PORT = 32_767;
const PROBES = 50;

export interface StartOnFreePortOptions {
  /** How many ports to try before giving up (default 5). */
  attempts?: number;
}

/**
 * Starts something that must know its own port before it listens, such as a child process
 * given `API_PORT` and a URL built from it. Prefer `listen(0)` and reading back the assigned
 * port; use this only when that is impossible. A port only ever looks free until it is bound,
 * so when `start` fails with `EADDRINUSE` (another test took the port first) this tries again
 * on another one. `start` must release whatever it started before it throws.
 */
export async function startOnFreePort<T>(
  start: (port: number) => Promise<T>,
  options: StartOnFreePortOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  for (let attempt = 1; ; attempt += 1) {
    const port = await freePort();
    try {
      return await start(port);
    } catch (error) {
      if (attempt >= attempts || !isAddressInUse(error)) throw error;
    }
  }
}

/** A port from the range above that nothing on 127.0.0.1 listens on right now. */
export async function freePort(): Promise<number> {
  for (let probe = 0; probe < PROBES; probe += 1) {
    const port = randomInt(FIRST_PORT, LAST_PORT + 1);
    if (await canListen(port)) return port;
  }
  throw new Error(`no free port in ${String(FIRST_PORT)}-${String(LAST_PORT)}`);
}

/**
 * Whether `error` is a listen that found its port taken: the error itself, or a child process's
 * failure that quotes the error from its stderr.
 */
export function isAddressInUse(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    (error as NodeJS.ErrnoException).code === 'EADDRINUSE' || error.message.includes('EADDRINUSE')
  );
}

async function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}
