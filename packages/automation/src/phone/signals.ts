/**
 * Word that phone work may be ready (docs/features/phone-execution.md, "When the phone runs"):
 * the `phone_work` table notifies its channel with the account's id whenever work becomes
 * claimable (migration `20261027195355_phone_work_notify`), and the API, listening, wakes the
 * account's app that waits for work (`waitForPhoneWork`), so a delist after a sale starts the
 * moment the engine hands it to the phone instead of at the app's next look.
 */
import { listenForNotifications, type NotificationListener } from '@listora/db';
import type { Logger } from '@listora/shared';

/** The channel `phone_work` notifies. */
export const PHONE_WORK_CHANNEL = 'phone_work';

export type PhoneWorkWake = 'signaled' | 'timeout' | 'aborted';

/** A wait for an account's next signal, started before the state it follows is read. */
export interface PhoneWorkSubscription {
  /** Resolves at the account's next signal, after `ms`, or when `signal` aborts. */
  wait(ms: number, signal?: AbortSignal): Promise<PhoneWorkWake>;
  /** Ends the subscription (a signal before `wait` is kept until then). */
  cancel(): void;
}

export class PhoneWorkSignals {
  readonly #waiters = new Map<string, Set<() => void>>();
  #listening: () => boolean;

  /** `listening` says whether signals reach it now; a source that may miss some says false. */
  constructor(listening: () => boolean = () => true) {
    this.#listening = listening;
  }

  /** Whether every signal reaches it now; while not, waits must not count on them. */
  get listening(): boolean {
    return this.#listening();
  }

  /** Wakes every wait of the account. */
  signal(accountId: string): void {
    for (const wake of this.#waiters.get(accountId) ?? []) wake();
  }

  subscribe(accountId: string): PhoneWorkSubscription {
    let signaled = false;
    let wake: (() => void) | null = null;
    const waiter = (): void => {
      signaled = true;
      wake?.();
    };
    const waiters = this.#waiters.get(accountId) ?? new Set();
    waiters.add(waiter);
    this.#waiters.set(accountId, waiters);
    const cancel = (): void => {
      waiters.delete(waiter);
      if (waiters.size === 0 && this.#waiters.get(accountId) === waiters) {
        this.#waiters.delete(accountId);
      }
    };
    return {
      cancel,
      wait: (ms, signal) =>
        new Promise<PhoneWorkWake>((resolve) => {
          if (signaled) {
            resolve('signaled');
            return;
          }
          if (signal?.aborted === true) {
            resolve('aborted');
            return;
          }
          const done = (outcome: PhoneWorkWake): void => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', aborted);
            wake = null;
            resolve(outcome);
          };
          const aborted = (): void => {
            done('aborted');
          };
          const timer = setTimeout(
            () => {
              done('timeout');
            },
            Math.max(0, ms),
          );
          signal?.addEventListener('abort', aborted, { once: true });
          wake = () => {
            done('signaled');
          };
        }),
    };
  }
}

/**
 * Signals from Postgres: one listener on `phone_work` (its own connection), for the process's
 * lifetime. `close` stops it.
 */
export function listenForPhoneWork(options: { connectionString: string; logger: Logger }): {
  signals: PhoneWorkSignals;
  close: () => Promise<void>;
} {
  const current: { listener: NotificationListener | null } = { listener: null };
  const signals = new PhoneWorkSignals(() => current.listener?.listening === true);
  const listener = listenForNotifications({
    connectionString: options.connectionString,
    channel: PHONE_WORK_CHANNEL,
    onNotification: (accountId) => {
      signals.signal(accountId);
    },
    onListening: (listening) => {
      options.logger.info({ listening }, 'phone work signals');
    },
    onError: (error) => {
      options.logger.warn({ err: error }, 'phone work signals lost their connection');
    },
  });
  current.listener = listener;
  return { signals, close: () => listener.close() };
}
