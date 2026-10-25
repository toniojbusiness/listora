/**
 * The fake's Commerce Notification API (`/commerce/notification/v1`): the alert-email config,
 * destinations with eBay's endpoint challenge, topics, and subscriptions, plus delivery of
 * signed notifications to every enabled subscription of a topic (README.md cites the pages).
 *
 * - A destination is created or changed only after its endpoint answers eBay's challenge
 *   (`GET <endpoint>?challenge_code=...` → `{"challengeResponse": sha256(code + token +
 *   endpoint)}`), else error 195020. Both need the alert email first (195003).
 * - `APPLICATION` topics are subscribed with the application token, `USER` topics with a
 *   seller's token; each token's owner sees only its own subscriptions, and holds at most one
 *   per topic (195012).
 * - `publish` signs one notification per matching enabled subscription whose destination is
 *   enabled and POSTs it; every delivery is recorded in `deliveries`.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { NotificationSigner, SignedNotification } from './notifications.ts';

export interface FakeNotificationTopic {
  topicId: string;
  scope: 'APPLICATION' | 'USER';
  authorizationScopes: string[];
  description: string;
}

/** The topics the fake serves; scopes and descriptions from eBay's topic list. */
export const FAKE_NOTIFICATION_TOPICS: readonly FakeNotificationTopic[] = [
  {
    topicId: 'MARKETPLACE_ACCOUNT_DELETION',
    scope: 'APPLICATION',
    authorizationScopes: ['https://api.ebay.com/oauth/api_scope'],
    description: 'Notification when a user requests their account be closed',
  },
  {
    topicId: 'AUTHORIZATION_REVOCATION',
    scope: 'APPLICATION',
    authorizationScopes: ['https://api.ebay.com/oauth/api_scope'],
    description: 'Sent to developers when a user revokes Developers Program permissions',
  },
  {
    topicId: 'ORDER_CONFIRMATION',
    scope: 'USER',
    authorizationScopes: [
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
    ],
    description: 'Notification sent to seller when buyer completes checkout',
  },
  {
    topicId: 'LISTING',
    scope: 'USER',
    authorizationScopes: ['https://api.ebay.com/oauth/api_scope/sell.listing.read'],
    description: 'Notification to sellers when a listing is created, updated, or ended',
  },
];

export interface FakeDestination {
  destinationId: string;
  name: string;
  status: 'ENABLED' | 'DISABLED' | 'MARKED_DOWN';
  endpoint: string;
  verificationToken: string;
}

export interface FakeSubscription {
  subscriptionId: string;
  topicId: string;
  status: 'ENABLED' | 'DISABLED';
  destinationId: string;
  schemaVersion: string;
  /** The seller whose token created it; `null` for the application's own. */
  owner: string | null;
}

export interface FakeDelivery {
  topic: string;
  subscriptionId: string;
  endpoint: string;
  notificationId: string;
  /** The subscriber's HTTP status, or the transport error. */
  status: number | 'unreachable';
}

export interface NotificationReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

class NotificationFailure extends Error {
  readonly status: number;
  readonly errorId: number;

  constructor(status: number, errorId: number, message: string) {
    super(message);
    this.status = status;
    this.errorId = errorId;
  }
}

const SCHEMA_VERSION = '1.0';
const VERIFICATION_TOKEN = /^[A-Za-z0-9_-]{32,80}$/;

export class FakeNotificationApi {
  readonly #signer: NotificationSigner;
  readonly #baseUrl: () => string;
  readonly #now: () => Date;
  readonly #allowHttpEndpoints: boolean;
  readonly destinations = new Map<string, FakeDestination>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  readonly deliveries: FakeDelivery[] = [];
  readonly #pending = new Set<Promise<void>>();
  alertEmail: string | null = null;

  constructor(options: {
    signer: NotificationSigner;
    baseUrl: () => string;
    now: () => Date;
    allowHttpEndpoints: boolean;
  }) {
    this.#signer = options.signer;
    this.#baseUrl = options.baseUrl;
    this.#now = options.now;
    this.#allowHttpEndpoints = options.allowHttpEndpoints;
  }

  /**
   * Answers one Notification API request (`path` below `/commerce/notification/v1`) for a
   * token's owner (`null`: the application token). `undefined` for a path it does not serve.
   */
  async handle(
    method: string,
    path: string,
    body: string,
    owner: string | null,
  ): Promise<NotificationReply | undefined> {
    try {
      return await this.#route(method, path, body, owner);
    } catch (error) {
      if (!(error instanceof NotificationFailure)) throw error;
      return {
        status: error.status,
        body: {
          errors: [
            {
              errorId: error.errorId,
              domain: 'API_NOTIFICATION',
              category: 'REQUEST',
              message: error.message,
              longMessage: error.message,
            },
          ],
        },
      };
    }
  }

  /**
   * Delivers a notification about `topicId` to every enabled subscription it concerns: the
   * application's for an `APPLICATION` topic, `seller`'s own for a `USER` topic. Resolves once
   * every delivery is answered.
   */
  async publish(
    topicId: string,
    data: Record<string, unknown>,
    seller: string | null,
  ): Promise<SignedNotification[]> {
    const topic = FAKE_NOTIFICATION_TOPICS.find((candidate) => candidate.topicId === topicId);
    if (topic === undefined) throw new Error(`the fake serves no topic ${topicId}`);
    const owner = topic.scope === 'APPLICATION' ? null : seller;
    const sent: SignedNotification[] = [];
    const deliveries: Promise<void>[] = [];
    for (const subscription of this.subscriptions.values()) {
      if (subscription.topicId !== topicId || subscription.status !== 'ENABLED') continue;
      if (subscription.owner !== owner) continue;
      const destination = this.destinations.get(subscription.destinationId);
      if (destination?.status !== 'ENABLED') continue;
      const notification = this.#signer.sign(topicId, data, {
        schemaVersion: subscription.schemaVersion,
        at: this.#now(),
      });
      sent.push(notification);
      deliveries.push(this.#deliver(subscription, destination.endpoint, notification));
    }
    await Promise.all(deliveries);
    return sent;
  }

  /** Publishes in the background (for eBay events the fake raises itself); see `settled`. */
  publishLater(topicId: string, data: Record<string, unknown>, seller: string | null): void {
    const delivery = this.publish(topicId, data, seller).then(
      () => undefined,
      () => undefined,
    );
    this.#pending.add(delivery);
    void delivery.finally(() => this.#pending.delete(delivery));
  }

  /** Resolves once every background delivery started so far is answered. */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  async #deliver(
    subscription: FakeSubscription,
    endpoint: string,
    notification: SignedNotification,
  ): Promise<void> {
    let status: FakeDelivery['status'];
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ebay-signature': notification.signature },
        body: notification.body,
        signal: AbortSignal.timeout(10_000),
      });
      await response.arrayBuffer();
      status = response.status;
    } catch {
      status = 'unreachable';
    }
    this.deliveries.push({
      topic: subscription.topicId,
      subscriptionId: subscription.subscriptionId,
      endpoint,
      notificationId: notification.message.notification.notificationId,
      status,
    });
  }

  async #route(
    method: string,
    path: string,
    body: string,
    owner: string | null,
  ): Promise<NotificationReply | undefined> {
    if (path === '/config') {
      if (method === 'GET') {
        return {
          status: 200,
          body: this.alertEmail === null ? {} : { alertEmail: this.alertEmail },
        };
      }
      if (method === 'PUT') {
        const { alertEmail } = parse(body);
        if (typeof alertEmail !== 'string' || !alertEmail.includes('@')) {
          throw new NotificationFailure(400, 195002, 'Invalid or missing email.');
        }
        this.alertEmail = alertEmail;
        return { status: 204 };
      }
    }
    const topic = /^\/topic\/([^/]+)$/.exec(path);
    if (method === 'GET' && topic?.[1] !== undefined) {
      const found = FAKE_NOTIFICATION_TOPICS.find(
        (candidate) => candidate.topicId === decodeURIComponent(topic[1] ?? ''),
      );
      if (found === undefined) throw new NotificationFailure(404, 195026, 'Topic not found.');
      return {
        status: 200,
        body: {
          topicId: found.topicId,
          description: found.description,
          status: 'ENABLED',
          context: 'SELLING',
          scope: found.scope,
          filterable: false,
          authorizationScopes: found.authorizationScopes,
          supportedPayloads: [
            {
              schemaVersion: SCHEMA_VERSION,
              format: ['JSON'],
              deliveryProtocol: 'HTTPS',
              deprecated: false,
            },
          ],
        },
      };
    }
    if (path === '/destination') {
      if (method === 'GET') {
        return {
          status: 200,
          body: {
            total: this.destinations.size,
            limit: 100,
            destinations: [...this.destinations.values()].map(destinationView),
          },
        };
      }
      if (method === 'POST') {
        const request = await this.#destinationRequest(body);
        if ([...this.destinations.values()].some((d) => d.endpoint === request.endpoint)) {
          throw new NotificationFailure(409, 195021, 'Destination exists for this endpoint.');
        }
        const destinationId = randomUUID();
        this.destinations.set(destinationId, { destinationId, ...request });
        return {
          status: 201,
          body: {},
          headers: {
            location: `${this.#baseUrl()}/commerce/notification/v1/destination/${destinationId}`,
          },
        };
      }
    }
    const destination = /^\/destination\/([^/]+)$/.exec(path);
    if (destination?.[1] !== undefined) {
      const existing = this.destinations.get(decodeURIComponent(destination[1]));
      if (existing === undefined) {
        throw new NotificationFailure(404, 195022, 'Destination not found.');
      }
      if (method === 'GET') return { status: 200, body: destinationView(existing) };
      if (method === 'PUT') {
        const request = await this.#destinationRequest(body);
        Object.assign(existing, request);
        return { status: 204 };
      }
    }
    if (path === '/subscription') {
      if (method === 'GET') {
        const own = [...this.subscriptions.values()].filter((s) => s.owner === owner);
        return {
          status: 200,
          body: { total: own.length, limit: 100, subscriptions: own.map(subscriptionView) },
        };
      }
      if (method === 'POST') {
        const request = this.#subscriptionRequest(parse(body), owner);
        if (
          [...this.subscriptions.values()].some(
            (s) => s.owner === owner && s.topicId === request.topicId,
          )
        ) {
          throw new NotificationFailure(409, 195012, 'Subscription already exists.');
        }
        const subscriptionId = randomUUID();
        this.subscriptions.set(subscriptionId, { subscriptionId, owner, ...request });
        return {
          status: 201,
          body: {},
          headers: {
            location: `${this.#baseUrl()}/commerce/notification/v1/subscription/${subscriptionId}`,
          },
        };
      }
    }
    const subscription = /^\/subscription\/([^/]+)(\/enable|\/disable)?$/.exec(path);
    if (subscription?.[1] !== undefined) {
      const existing = this.subscriptions.get(decodeURIComponent(subscription[1]));
      if (existing?.owner !== owner) {
        throw new NotificationFailure(404, 195017, 'Subscription not found.');
      }
      const action = subscription[2];
      if (method === 'GET' && action === undefined) {
        return { status: 200, body: subscriptionView(existing) };
      }
      if (method === 'PUT' && action === undefined) {
        const request = this.#subscriptionRequest(
          { ...parse(body), topicId: existing.topicId },
          owner,
        );
        Object.assign(existing, request);
        return { status: 204 };
      }
      if (method === 'POST' && action !== undefined) {
        const status = action === '/enable' ? 'ENABLED' : 'DISABLED';
        if (status === 'ENABLED') this.#requireEnabledDestination(existing.destinationId);
        existing.status = status;
        return { status: 204 };
      }
    }
    return undefined;
  }

  async #destinationRequest(body: string): Promise<Omit<FakeDestination, 'destinationId'>> {
    if (this.alertEmail === null) {
      throw new NotificationFailure(
        409,
        195003,
        'Please provide configurations required for notifications. Refer to /config',
      );
    }
    const { name, status, deliveryConfig } = parse(body);
    const config = (deliveryConfig ?? {}) as Record<string, unknown>;
    const endpoint = config['endpoint'];
    const verificationToken = config['verificationToken'];
    const scheme = this.#allowHttpEndpoints ? /^https?:\/\/\S+$/ : /^https:\/\/\S+$/;
    if (typeof endpoint !== 'string' || !scheme.test(endpoint)) {
      throw new NotificationFailure(400, 195018, 'Invalid or missing endpoint.');
    }
    if (typeof verificationToken !== 'string' || !VERIFICATION_TOKEN.test(verificationToken)) {
      throw new NotificationFailure(400, 195019, 'Invalid or missing verification token.');
    }
    if (status !== 'ENABLED' && status !== 'DISABLED') {
      throw new NotificationFailure(400, 195023, 'Invalid or missing destination status.');
    }
    if (!(await challenge(endpoint, verificationToken))) {
      throw new NotificationFailure(
        409,
        195020,
        'Challenge verification failed for requested endpoint',
      );
    }
    return { name: typeof name === 'string' ? name : '', status, endpoint, verificationToken };
  }

  #subscriptionRequest(
    request: Record<string, unknown>,
    owner: string | null,
  ): Omit<FakeSubscription, 'subscriptionId' | 'owner'> {
    const topic = FAKE_NOTIFICATION_TOPICS.find(
      (candidate) => candidate.topicId === request['topicId'],
    );
    if (topic === undefined) {
      throw new NotificationFailure(400, 195027, 'Invalid or missing topic id.');
    }
    // An application token cannot subscribe to a seller's topic, nor a seller's to the app's.
    if ((topic.scope === 'USER') !== (owner !== null)) {
      throw new NotificationFailure(403, 195011, 'Not authorized for this topic.');
    }
    const { status, destinationId, payload } = request;
    if (status !== 'ENABLED' && status !== 'DISABLED') {
      throw new NotificationFailure(400, 195006, 'Invalid or missing subscription status.');
    }
    if (typeof destinationId !== 'string' || !this.destinations.has(destinationId)) {
      throw new NotificationFailure(400, 195007, 'Invalid or missing destination id.');
    }
    const details = (payload ?? {}) as Record<string, unknown>;
    if (details['schemaVersion'] !== SCHEMA_VERSION) {
      throw new NotificationFailure(
        400,
        195008,
        'Invalid or missing schema version. Please refer to /topic/{topic_id} for supported schema versions.',
      );
    }
    if (details['format'] !== 'JSON') {
      throw new NotificationFailure(
        400,
        195009,
        'Specified format is not supported for the topic.',
      );
    }
    if (details['deliveryProtocol'] !== 'HTTPS') {
      throw new NotificationFailure(400, 195010, 'Invalid or missing protocol');
    }
    if (status === 'ENABLED') this.#requireEnabledDestination(destinationId);
    return { topicId: topic.topicId, status, destinationId, schemaVersion: SCHEMA_VERSION };
  }

  #requireEnabledDestination(destinationId: string): void {
    if (this.destinations.get(destinationId)?.status !== 'ENABLED') {
      throw new NotificationFailure(
        409,
        195015,
        'The subscription cannot be enabled since the destination is not enabled.',
      );
    }
  }
}

/** eBay's challenge: the endpoint must answer with the hash of code, token, and endpoint. */
async function challenge(endpoint: string, verificationToken: string): Promise<boolean> {
  const code = randomUUID().replaceAll('-', '');
  const url = new URL(endpoint);
  url.searchParams.set('challenge_code', code);
  const expected = createHash('sha256')
    .update(code)
    .update(verificationToken)
    .update(endpoint)
    .digest('hex');
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    if (response.status !== 200) return false;
    if (!(response.headers.get('content-type') ?? '').startsWith('application/json')) return false;
    return (JSON.parse(text) as { challengeResponse?: unknown }).challengeResponse === expected;
  } catch {
    return false;
  }
}

function destinationView(destination: FakeDestination): Record<string, unknown> {
  return {
    destinationId: destination.destinationId,
    name: destination.name,
    status: destination.status,
    deliveryConfig: {
      endpoint: destination.endpoint,
      verificationToken: destination.verificationToken,
    },
  };
}

function subscriptionView(subscription: FakeSubscription): Record<string, unknown> {
  return {
    subscriptionId: subscription.subscriptionId,
    topicId: subscription.topicId,
    status: subscription.status,
    destinationId: subscription.destinationId,
    creationDate: '2026-10-24T00:00:00.000Z',
    payload: {
      format: 'JSON',
      schemaVersion: subscription.schemaVersion,
      deliveryProtocol: 'HTTPS',
    },
  };
}

function parse(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
