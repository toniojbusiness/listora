import type { Logger } from '@listora/shared';

import type { BackgroundPush } from './background.ts';
import type { PushNotification } from './notification.ts';

/**
 * Delivers a notification to every device signed in to its account. It throws when delivery
 * failed for a reason that clears (the push service is down), so the outbox job runs again.
 */
export interface PushSender {
  send(notification: PushNotification, signal: AbortSignal): Promise<void>;
  /** Wakes the account's devices in the background, showing nothing (background.ts). */
  sendBackground(push: BackgroundPush, signal: AbortSignal): Promise<void>;
}

/**
 * The fake driver (`PUSH_DRIVER=fake`): records each notification and logs it, so a developer
 * sees what a phone would show. Tests read `sent` and can make the next sends fail.
 */
export class RecordingPushSender implements PushSender {
  readonly sent: PushNotification[] = [];
  readonly sentBackground: BackgroundPush[] = [];
  readonly #logger: Pick<Logger, 'info'> | undefined;
  #failures = 0;

  constructor(options: { logger?: Pick<Logger, 'info'> } = {}) {
    this.#logger = options.logger;
  }

  /** The next `count` sends throw, as an unreachable push service would. */
  failNext(count = 1): void {
    this.#failures = count;
  }

  send(notification: PushNotification): Promise<void> {
    if (this.#failures > 0) {
      this.#failures -= 1;
      return Promise.reject(new Error('the fake push service is unavailable'));
    }
    this.sent.push(notification);
    this.#logger?.info(
      {
        accountId: notification.accountId,
        category: notification.category,
        title: notification.title,
        body: notification.body,
        wakesApp: notification.wakesApp === true,
      },
      'push notification (fake driver)',
    );
    return Promise.resolve();
  }

  sendBackground(push: BackgroundPush): Promise<void> {
    if (this.#failures > 0) {
      this.#failures -= 1;
      return Promise.reject(new Error('the fake push service is unavailable'));
    }
    this.sentBackground.push(push);
    this.#logger?.info(
      { accountId: push.accountId, reason: push.reason },
      'background push (fake driver)',
    );
    return Promise.resolve();
  }
}
