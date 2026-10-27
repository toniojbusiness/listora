/**
 * Postgres notifications (`LISTEN`): a process hears what another one's transaction told a
 * channel (`pg_notify`) the moment that transaction commits, instead of polling for it. One
 * dedicated connection per listener, outside the pool (a pooled connection would stop hearing
 * once released). It reconnects after the connection drops (a database restart, a failover),
 * with a growing pause; while it is down nothing is heard, so a caller that depends on it must
 * still look on its own schedule (`listening` says which).
 */
import pg from 'pg';

export interface NotificationListenerOptions {
  connectionString: string;
  /** The channel, a plain identifier (`phone_work`). */
  channel: string;
  /** Each notification's payload, in the order Postgres delivered them. */
  onNotification: (payload: string) => void;
  /** Whether it hears the channel now: `true` once connected and listening, `false` when not. */
  onListening?: (listening: boolean) => void;
  /** A connection that failed or dropped; it connects again on its own. */
  onError?: (error: Error) => void;
  /** The first pause before connecting again (default 1 s), doubled up to 30 s. */
  retryMs?: number;
}

export interface NotificationListener {
  /** Whether it hears the channel now. */
  readonly listening: boolean;
  /** Stops listening and closes the connection. */
  close(): Promise<void>;
}

const MAX_RETRY_MS = 30_000;
const CHANNEL = /^[a-z_][a-z0-9_]*$/;

/** Starts listening to `channel`; it keeps listening until `close`. */
export function listenForNotifications(options: NotificationListenerOptions): NotificationListener {
  if (!CHANNEL.test(options.channel)) {
    throw new Error(`"${options.channel}" is not a channel name Listora listens to`);
  }
  const firstRetryMs = options.retryMs ?? 1_000;
  let client: pg.Client | null = null;
  let listening = false;
  let closed = false;
  let retryMs = firstRetryMs;
  let retry: NodeJS.Timeout | null = null;

  const setListening = (value: boolean): void => {
    if (listening === value) return;
    listening = value;
    options.onListening?.(value);
  };

  const dropped = (current: pg.Client, error: Error): void => {
    if (client !== current) return;
    client = null;
    setListening(false);
    current.removeAllListeners();
    current.on('error', () => undefined);
    void current.end().catch(() => undefined);
    if (closed) return;
    options.onError?.(error);
    retry = setTimeout(connect, retryMs);
    retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
  };

  function connect(): void {
    retry = null;
    if (closed) return;
    const current = new pg.Client({ connectionString: options.connectionString });
    client = current;
    current.on('notification', (message) => {
      if (message.channel === options.channel) options.onNotification(message.payload ?? '');
    });
    current.on('error', (error) => {
      dropped(current, error);
    });
    current.on('end', () => {
      dropped(current, new Error('the notification connection ended'));
    });
    current
      .connect()
      .then(() => current.query(`listen ${options.channel}`))
      .then(() => {
        if (client !== current) return;
        retryMs = firstRetryMs;
        setListening(true);
      })
      .catch((error: unknown) => {
        dropped(current, error instanceof Error ? error : new Error(String(error)));
      });
  }

  connect();
  return {
    get listening() {
      return listening;
    },
    async close() {
      closed = true;
      if (retry !== null) clearTimeout(retry);
      const current = client;
      client = null;
      setListening(false);
      if (current !== null) {
        current.removeAllListeners();
        current.on('error', () => undefined);
        await current.end().catch(() => undefined);
      }
    },
  };
}
