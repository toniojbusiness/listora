/**
 * Word that phone work may be ready (docs/features/phone-execution.md, "When the phone runs"):
 * the `phone_work` table notifies its channel with the account's id whenever work becomes
 * claimable (migration `20261027195355_phone_work_notify`), and the API, listening, wakes the
 * account's app that waits for work (`waitForPhoneWork`), so a delist after a sale starts the
 * moment the engine hands it to the phone instead of at the app's next look.
 */
import {
  KeyedSignals,
  listenForSignals,
  type SignalSubscription,
  type SignalWake,
} from '@listora/db';
import type { Logger } from '@listora/shared';

/** The channel `phone_work` notifies. */
export const PHONE_WORK_CHANNEL = 'phone_work';

/** Signals keyed by account id. */
export { KeyedSignals as PhoneWorkSignals };
export type PhoneWorkSubscription = SignalSubscription;
export type PhoneWorkWake = SignalWake;

/**
 * Signals from Postgres: one listener on `phone_work` (its own connection), for the process's
 * lifetime. `close` stops it.
 */
export function listenForPhoneWork(options: { connectionString: string; logger: Logger }): {
  signals: KeyedSignals;
  close: () => Promise<void>;
} {
  return listenForSignals({
    connectionString: options.connectionString,
    channel: PHONE_WORK_CHANNEL,
    onListening: (listening) => {
      options.logger.info({ listening }, 'phone work signals');
    },
    onError: (error) => {
      options.logger.warn({ err: error }, 'phone work signals lost their connection');
    },
  });
}
