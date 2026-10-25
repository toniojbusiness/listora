/**
 * Keeps Listora's eBay notification subscriptions in place (notification-api.ts). Every
 * method is idempotent, so the worker runs it whenever a seller connects and again every day:
 *
 * - **Destination** (application token): the alert email is set (eBay requires it), and one
 *   enabled destination points at Listora's endpoint with its verification token. eBay
 *   challenges the endpoint when the destination is created or changed, so the API must be
 *   serving it first.
 * - **Application topics** (application token): `MARKETPLACE_ACCOUNT_DELETION`, which eBay
 *   requires of every application, and `AUTHORIZATION_REVOCATION`.
 * - **Seller topics** (each seller's own token): `ORDER_CONFIRMATION` and `LISTING`.
 *
 * Each topic is subscribed with its newest JSON schema version (`getTopic`), enabled, and sent
 * to the destination; an existing subscription that differs is updated, never duplicated.
 * Results are per topic, so one refused topic never hides the others.
 */
import {
  createNotificationDestination,
  createNotificationSubscription,
  getNotificationConfig,
  getNotificationDestinations,
  getNotificationSubscriptions,
  getNotificationTopic,
  updateNotificationConfig,
  updateNotificationDestination,
  updateNotificationSubscription,
  type NotificationSubscription,
  type NotificationTopic,
} from './notification-api.ts';
import type { EbayNotificationTopic } from './notification-events.ts';
import type { ApplicationToken } from './oauth.ts';
import type { RestEndpoints, RestError, RestRequestOptions, RestResult } from './rest.ts';

/** Topics every application subscribes to once, with the application token. */
export const EBAY_APPLICATION_TOPICS = [
  'MARKETPLACE_ACCOUNT_DELETION',
  'AUTHORIZATION_REVOCATION',
] as const satisfies readonly EbayNotificationTopic[];

/** Topics each connected seller subscribes to, with their own token. */
export const EBAY_SELLER_TOPICS = [
  'ORDER_CONFIRMATION',
  'LISTING',
] as const satisfies readonly EbayNotificationTopic[];

export interface EbayNotificationSettings {
  /** The exact public https URL eBay delivers to (and hashes into the challenge). */
  endpoint: string;
  /** 32 to 80 of `[A-Za-z0-9_-]`; also the challenge's secret. */
  verificationToken: string;
  /** Where eBay sends Notification API alerts (required before the first destination). */
  alertEmail: string | null;
}

/** Why eBay refused, without the request or any token. */
export interface NotificationProblem {
  code: string;
  message: string;
}

export type DestinationResult =
  | { type: 'ready'; destinationId: string }
  /** eBay needs an alert email first and none is configured. */
  | ({ type: 'config_required' } & NotificationProblem)
  /** eBay could not verify the endpoint's challenge answer. */
  | ({ type: 'challenge_failed' } & NotificationProblem)
  | ({ type: 'refused' } & NotificationProblem)
  /** eBay could not be asked now; try again later. */
  | ({ type: 'unavailable' } & NotificationProblem);

export type TopicProblem = NotificationProblem & {
  /**
   * `not_authorized`: the token may not subscribe (eBay 195011: a missing scope or approval).
   * `token_rejected`: eBay refused the access token itself (401); a fresh one may work.
   */
  type: 'not_authorized' | 'token_rejected' | 'refused' | 'unavailable';
};

export type TopicResult = { topicId: EbayNotificationTopic } & (
  { type: 'subscribed'; subscriptionId: string; schemaVersion: string } | TopicProblem
);

export interface EbayNotificationSubscriptionsOptions {
  endpoints: Pick<RestEndpoints, 'api'>;
  applicationToken: ApplicationToken;
  settings: EbayNotificationSettings;
  timeoutMs?: number;
  /** How long topic metadata is reused (default one hour). */
  topicTtlMs?: number;
  now?: () => number;
}

const DESTINATION_NAME = 'Listora';

export class EbayNotificationSubscriptions {
  readonly #endpoints: Pick<RestEndpoints, 'api'>;
  readonly #applicationToken: ApplicationToken;
  readonly #settings: EbayNotificationSettings;
  readonly #timeoutMs: number;
  readonly #topicTtlMs: number;
  readonly #now: () => number;
  readonly #topics = new Map<string, { topic: NotificationTopic; expiresAt: number }>();

  constructor(options: EbayNotificationSubscriptionsOptions) {
    this.#endpoints = options.endpoints;
    this.#applicationToken = options.applicationToken;
    this.#settings = options.settings;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#topicTtlMs = options.topicTtlMs ?? 60 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  /** Makes sure the alert email and Listora's enabled destination exist. */
  async ensureDestination(signal: AbortSignal): Promise<DestinationResult> {
    const options = await this.#applicationOptions(signal);
    if ('type' in options) return options;

    const config = await getNotificationConfig(this.#endpoints, options);
    this.#forgetRefused(config, options);
    if (config.type !== 'ok') return failure(config);
    if (config.value.alertEmail === null) {
      if (this.#settings.alertEmail === null) {
        return {
          type: 'config_required',
          code: 'alert_email_required',
          message: 'eBay needs an alert email for notifications (EBAY_NOTIFICATION_ALERT_EMAIL).',
        };
      }
      const updated = await updateNotificationConfig(
        this.#endpoints,
        this.#settings.alertEmail,
        options,
      );
      if (updated.type !== 'ok') return failure(updated);
    }

    const destinations = await getNotificationDestinations(this.#endpoints, options);
    if (destinations.type !== 'ok') return failure(destinations);
    const request = {
      name: DESTINATION_NAME,
      endpoint: this.#settings.endpoint,
      verificationToken: this.#settings.verificationToken,
      status: 'ENABLED',
    } as const;
    const existing = destinations.value.find(
      (destination) => destination.endpoint === this.#settings.endpoint,
    );
    if (existing !== undefined) {
      const current =
        existing.status === 'ENABLED' &&
        (existing.verificationToken === null ||
          existing.verificationToken === this.#settings.verificationToken);
      if (current) return { type: 'ready', destinationId: existing.destinationId };
      const updated = await updateNotificationDestination(
        this.#endpoints,
        existing.destinationId,
        request,
        options,
      );
      return updated.type === 'ok'
        ? { type: 'ready', destinationId: existing.destinationId }
        : failure(updated);
    }
    const created = await createNotificationDestination(this.#endpoints, request, options);
    if (created.type === 'ok') return { type: 'ready', destinationId: created.value };
    // 195021: another worker created it meanwhile; use that one.
    if (created.type === 'error' && created.status === 409 && hasError(created, 195021)) {
      const relisted = await getNotificationDestinations(this.#endpoints, options);
      const raced =
        relisted.type === 'ok'
          ? relisted.value.find((destination) => destination.endpoint === this.#settings.endpoint)
          : undefined;
      if (raced !== undefined) return { type: 'ready', destinationId: raced.destinationId };
    }
    return failure(created);
  }

  /** Subscribes the application's own topics (the application token). */
  async ensureApplicationTopics(
    destinationId: string,
    signal: AbortSignal,
  ): Promise<TopicResult[]> {
    const options = await this.#applicationOptions(signal);
    if ('type' in options) {
      return EBAY_APPLICATION_TOPICS.map((topicId) => ({ topicId, ...options }));
    }
    return this.#ensureTopics(EBAY_APPLICATION_TOPICS, 'APPLICATION', destinationId, options);
  }

  /** Subscribes one seller's topics with that seller's access token. */
  async ensureSellerTopics(
    destinationId: string,
    sellerAccessToken: string,
    signal: AbortSignal,
  ): Promise<TopicResult[]> {
    return this.#ensureTopics(EBAY_SELLER_TOPICS, 'USER', destinationId, {
      token: sellerAccessToken,
      signal,
      timeoutMs: this.#timeoutMs,
    });
  }

  async #ensureTopics(
    topicIds: readonly EbayNotificationTopic[],
    scope: NotificationTopic['scope'],
    destinationId: string,
    options: RestRequestOptions,
  ): Promise<TopicResult[]> {
    const listed = await getNotificationSubscriptions(this.#endpoints, options);
    if (scope === 'APPLICATION') this.#forgetRefused(listed, options);
    if (listed.type !== 'ok') {
      const problem = failure(listed);
      return topicIds.map((topicId) => ({ topicId, ...topicFailure(problem) }));
    }
    const results: TopicResult[] = [];
    for (const topicId of topicIds) {
      results.push(await this.#ensureTopic(topicId, scope, destinationId, listed.value, options));
    }
    return results;
  }

  async #ensureTopic(
    topicId: EbayNotificationTopic,
    scope: NotificationTopic['scope'],
    destinationId: string,
    subscriptions: NotificationSubscription[],
    options: RestRequestOptions,
  ): Promise<TopicResult> {
    const topic = await this.#topic(topicId, options);
    if (topic.type !== 'ok') return { topicId, ...topicFailure(failure(topic)) };
    const schemaVersion = topic.value.schemaVersions[0];
    if (schemaVersion === undefined) {
      return {
        topicId,
        type: 'refused',
        code: 'no_supported_payload',
        message: `eBay offers no JSON payload over HTTPS for ${topicId}.`,
      };
    }
    if (topic.value.scope !== scope) {
      return {
        topicId,
        type: 'refused',
        code: 'unexpected_topic_scope',
        message: `eBay lists ${topicId} as a ${topic.value.scope} topic, not ${scope}.`,
      };
    }
    const request = { topicId, destinationId, schemaVersion, status: 'ENABLED' } as const;
    const subscribed = { topicId, type: 'subscribed', schemaVersion } as const;

    let existing = subscriptions.find((subscription) => subscription.topicId === topicId);
    if (existing === undefined) {
      const created = await createNotificationSubscription(this.#endpoints, request, options);
      if (created.type === 'ok') return { ...subscribed, subscriptionId: created.value };
      // 195012: it exists after all (another worker made it meanwhile): update that one.
      if (!(created.type === 'error' && created.status === 409 && hasError(created, 195012))) {
        return { topicId, ...topicFailure(failure(created)) };
      }
      const relisted = await getNotificationSubscriptions(this.#endpoints, options);
      if (relisted.type !== 'ok') return { topicId, ...topicFailure(failure(relisted)) };
      existing = relisted.value.find((subscription) => subscription.topicId === topicId);
      if (existing === undefined) {
        return { topicId, type: 'unavailable', code: 'subscription_not_found', message: '' };
      }
    }
    if (
      existing.status === 'ENABLED' &&
      existing.destinationId === destinationId &&
      existing.schemaVersion === schemaVersion
    ) {
      return { ...subscribed, subscriptionId: existing.subscriptionId };
    }
    const updated = await updateNotificationSubscription(
      this.#endpoints,
      existing.subscriptionId,
      request,
      options,
    );
    return updated.type === 'ok'
      ? { ...subscribed, subscriptionId: existing.subscriptionId }
      : { topicId, ...topicFailure(failure(updated)) };
  }

  async #topic(
    topicId: string,
    options: RestRequestOptions,
  ): Promise<RestResult<NotificationTopic>> {
    const cached = this.#topics.get(topicId);
    if (cached !== undefined && cached.expiresAt > this.#now()) {
      return { type: 'ok', value: cached.topic };
    }
    // Topics are public metadata: the application token reads them for every scope.
    const app = await this.#applicationOptions(options.signal);
    const result = await getNotificationTopic(
      this.#endpoints,
      topicId,
      'type' in app ? options : app,
    );
    if (result.type === 'ok') {
      this.#topics.set(topicId, { topic: result.value, expiresAt: this.#now() + this.#topicTtlMs });
    }
    return result;
  }

  /** Forgets the application token when eBay refused it, so the next call gets a new one. */
  #forgetRefused(result: RestResult<unknown>, options: RestRequestOptions): void {
    if (result.type === 'error' && result.status === 401) {
      this.#applicationToken.forget(options.token);
    }
  }

  async #applicationOptions(
    signal: AbortSignal,
  ): Promise<RestRequestOptions | ({ type: 'unavailable' } & NotificationProblem)> {
    try {
      return {
        token: await this.#applicationToken.get(signal),
        signal,
        timeoutMs: this.#timeoutMs,
      };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return {
        type: 'unavailable',
        code: typeof code === 'string' ? code : 'token_unavailable',
        message: "eBay's sign-in service did not issue Listora's application token.",
      };
    }
  }
}

type Failure = Exclude<DestinationResult, { type: 'ready' }>;

function failure(result: Exclude<RestResult<unknown>, { type: 'ok' }>): Failure {
  if (result.type !== 'error') {
    return { type: 'unavailable', code: result.code, message: 'eBay could not be reached.' };
  }
  const first: RestError | undefined = result.errors[0];
  const message =
    [first?.longMessage, first?.message].find((text) => text !== undefined && text !== '') ??
    `eBay answered ${String(result.status)}.`;
  const code =
    first === undefined ? `http_${String(result.status)}` : `ebay_${String(first.errorId)}`;
  // A refused access token (401) is retried with a new one; see `topicFailure`.
  if (result.status === 401 || result.status === 429 || result.status >= 500) {
    return { type: 'unavailable', code, message };
  }
  if (hasError(result, 195003)) return { type: 'config_required', code, message };
  if (hasError(result, 195020)) return { type: 'challenge_failed', code, message };
  return { type: 'refused', code, message };
}

function topicFailure(problem: Failure): TopicProblem {
  if (problem.code === 'ebay_1001' || problem.code === 'http_401') {
    return { type: 'token_rejected', code: problem.code, message: problem.message };
  }
  if (problem.type === 'unavailable') return problem;
  if (problem.code === 'ebay_195011' || problem.code === 'http_403') {
    return { type: 'not_authorized', code: problem.code, message: problem.message };
  }
  return { type: 'refused', code: problem.code, message: problem.message };
}

function hasError(result: { errors: RestError[] }, errorId: number): boolean {
  return result.errors.some((error) => error.errorId === errorId);
}
