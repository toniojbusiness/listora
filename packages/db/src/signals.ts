/**
 * Waits that end the moment a Postgres notification names their key (an account's or an
 * item's id), for long-polls: the API answers a client's wait as soon as the state it waits on
 * changes, instead of the client asking again on a timer. One listener per channel and process
 * (`listenForSignals`); a subscription made before the state is read hears a change committed
 * in between. While the listener is down signals are missed, so a wait must then look on its own
 * schedule (`listening`).
 */
import { listenForNotifications, type NotificationListener } from './notifications.ts';

export type SignalWake = 'signaled' | 'timeout' | 'aborted';

/** A wait for a key's next signal, started before the state it follows is read. */
export interface SignalSubscription {
  /** Resolves at the key's next signal, after `ms`, or when `signal` aborts. */
  wait(ms: number, signal?: AbortSignal): Promise<SignalWake>;
  /** Ends the subscription (a signal before `wait` is kept until then). */
  cancel(): void;
}

export class KeyedSignals {
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

  /** Wakes every wait of the key. */
  signal(key: string): void {
    for (const wake of this.#waiters.get(key) ?? []) wake();
  }

  subscribe(key: string): SignalSubscription {
    let signaled = false;
    let wake: (() => void) | null = null;
    const waiter = (): void => {
      signaled = true;
      wake?.();
    };
    const waiters = this.#waiters.get(key) ?? new Set();
    waiters.add(waiter);
    this.#waiters.set(key, waiters);
    const cancel = (): void => {
      waiters.delete(waiter);
      if (waiters.size === 0 && this.#waiters.get(key) === waiters) {
        this.#waiters.delete(key);
      }
    };
    return {
      cancel,
      wait: (ms, signal) =>
        new Promise<SignalWake>((resolve) => {
          if (signaled) {
            resolve('signaled');
            return;
          }
          if (signal?.aborted === true) {
            resolve('aborted');
            return;
          }
          const done = (outcome: SignalWake): void => {
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

/** A channel's signals: one listener for the process's lifetime, keyed by the payload. */
export function listenForSignals(options: {
  connectionString: string;
  /** The channel, a plain identifier. */
  channel: string;
  onListening?: (listening: boolean) => void;
  onError?: (error: Error) => void;
}): { signals: KeyedSignals; close: () => Promise<void> } {
  const current: { listener: NotificationListener | null } = { listener: null };
  const signals = new KeyedSignals(() => current.listener?.listening === true);
  const listener = listenForNotifications({
    connectionString: options.connectionString,
    channel: options.channel,
    onNotification: (key) => {
      signals.signal(key);
    },
    ...(options.onListening === undefined ? {} : { onListening: options.onListening }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  current.listener = listener;
  return { signals, close: () => listener.close() };
}
