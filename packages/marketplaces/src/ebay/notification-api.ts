/**
 * eBay's Commerce Notification API (`/commerce/notification/v1`), the calls Listora uses to
 * manage its subscriptions (shapes from `commerce_notification_v1_oas3.json`, read 2026-10-24):
 *
 * - `config`: the application's alert email; eBay refuses destinations and subscriptions until
 *   it is set (error 195003).
 * - `destination`: the HTTPS endpoint notifications go to, with its verification token. eBay
 *   checks the endpoint with a challenge (notification-events.ts) when it is created or
 *   changed (error 195020 when the check fails, 195021 when the endpoint already exists).
 * - `topic`: a topic's scope (`APPLICATION` topics take the application token, `USER` topics a
 *   seller's token from the authorization-code grant), the OAuth scopes it needs, and its
 *   supported payloads.
 * - `subscription`: one per application (or seller) and topic (error 195012 when it already
 *   exists, 195011 when the token is not authorized for the topic).
 *
 * Every function returns a `RestResult` instead of throwing for an eBay answer.
 */
import { rest, type RestEndpoints, type RestRequestOptions, type RestResult } from './rest.ts';

const BASE = '/commerce/notification/v1';

export type NotificationStatus = 'ENABLED' | 'DISABLED' | 'MARKED_DOWN' | 'UNKNOWN';

export interface NotificationTopic {
  topicId: string;
  scope: 'APPLICATION' | 'USER' | 'UNKNOWN';
  /** The OAuth scopes a token needs to subscribe. */
  authorizationScopes: string[];
  /** Schema versions with a JSON payload over HTTPS, newest first; deprecated ones excluded. */
  schemaVersions: string[];
}

export interface NotificationDestination {
  destinationId: string;
  name: string;
  status: NotificationStatus;
  endpoint: string | null;
  /** eBay returns the token with the destination; `null` when it does not. */
  verificationToken: string | null;
}

export interface NotificationSubscription {
  subscriptionId: string;
  topicId: string;
  status: NotificationStatus;
  destinationId: string | null;
  schemaVersion: string | null;
}

export interface SubscriptionRequest {
  topicId: string;
  destinationId: string;
  schemaVersion: string;
  status: 'ENABLED' | 'DISABLED';
}

export interface DestinationRequest {
  name: string;
  endpoint: string;
  verificationToken: string;
  status: 'ENABLED' | 'DISABLED';
}

export function getNotificationConfig(
  endpoints: Pick<RestEndpoints, 'api'>,
  options: RestRequestOptions,
): Promise<RestResult<{ alertEmail: string | null }>> {
  return rest('GET', `${endpoints.api}${BASE}/config`, options, (body) => {
    const alertEmail = (body as { alertEmail?: unknown } | null)?.alertEmail;
    return { alertEmail: typeof alertEmail === 'string' && alertEmail !== '' ? alertEmail : null };
  });
}

export function updateNotificationConfig(
  endpoints: Pick<RestEndpoints, 'api'>,
  alertEmail: string,
  options: RestRequestOptions,
): Promise<RestResult<true>> {
  return rest('PUT', `${endpoints.api}${BASE}/config`, options, () => true, { alertEmail });
}

export function getNotificationTopic(
  endpoints: Pick<RestEndpoints, 'api'>,
  topicId: string,
  options: RestRequestOptions,
): Promise<RestResult<NotificationTopic>> {
  return rest(
    'GET',
    `${endpoints.api}${BASE}/topic/${encodeURIComponent(topicId)}`,
    options,
    (body) => {
      const topic = (body ?? {}) as Record<string, unknown>;
      if (topic['topicId'] !== topicId) return undefined;
      const scope = topic['scope'];
      const payloads = Array.isArray(topic['supportedPayloads'])
        ? (topic['supportedPayloads'] as Record<string, unknown>[])
        : [];
      const schemaVersions = payloads
        .filter((payload) => {
          const formats = Array.isArray(payload['format'])
            ? payload['format']
            : [payload['format']];
          return (
            payload['deprecated'] !== true &&
            formats.includes('JSON') &&
            (payload['deliveryProtocol'] ?? 'HTTPS') === 'HTTPS' &&
            typeof payload['schemaVersion'] === 'string'
          );
        })
        .map((payload) => payload['schemaVersion'] as string)
        .sort(compareVersionsDescending);
      return {
        topicId,
        scope: scope === 'APPLICATION' || scope === 'USER' ? scope : 'UNKNOWN',
        authorizationScopes: strings(topic['authorizationScopes']),
        schemaVersions,
      };
    },
  );
}

export async function getNotificationDestinations(
  endpoints: Pick<RestEndpoints, 'api'>,
  options: RestRequestOptions,
): Promise<RestResult<NotificationDestination[]>> {
  return pages(
    `${endpoints.api}${BASE}/destination?limit=100`,
    options,
    'destinations',
    (entry) => {
      const { destinationId, name, status, deliveryConfig } = entry;
      if (typeof destinationId !== 'string') return undefined;
      const config = (deliveryConfig ?? {}) as Record<string, unknown>;
      return {
        destinationId,
        name: typeof name === 'string' ? name : '',
        status: statusOf(status),
        endpoint: typeof config['endpoint'] === 'string' ? config['endpoint'] : null,
        verificationToken:
          typeof config['verificationToken'] === 'string' ? config['verificationToken'] : null,
      };
    },
  );
}

/** Creates a destination; answers its id (from the `Location` header). */
export function createNotificationDestination(
  endpoints: Pick<RestEndpoints, 'api'>,
  request: DestinationRequest,
  options: RestRequestOptions,
): Promise<RestResult<string>> {
  return rest(
    'POST',
    `${endpoints.api}${BASE}/destination`,
    options,
    (_body, headers) => lastPathSegment(headers.get('location')),
    destinationBody(request),
  );
}

export function updateNotificationDestination(
  endpoints: Pick<RestEndpoints, 'api'>,
  destinationId: string,
  request: DestinationRequest,
  options: RestRequestOptions,
): Promise<RestResult<true>> {
  return rest(
    'PUT',
    `${endpoints.api}${BASE}/destination/${encodeURIComponent(destinationId)}`,
    options,
    () => true,
    destinationBody(request),
  );
}

/** The subscriptions the token's owner holds (the application's, or one seller's). */
export function getNotificationSubscriptions(
  endpoints: Pick<RestEndpoints, 'api'>,
  options: RestRequestOptions,
): Promise<RestResult<NotificationSubscription[]>> {
  return pages(
    `${endpoints.api}${BASE}/subscription?limit=100`,
    options,
    'subscriptions',
    (entry) => {
      const { subscriptionId, topicId, status, destinationId, payload } = entry;
      if (typeof subscriptionId !== 'string' || typeof topicId !== 'string') return undefined;
      const schemaVersion = (payload as { schemaVersion?: unknown } | undefined)?.schemaVersion;
      return {
        subscriptionId,
        topicId,
        status: statusOf(status),
        destinationId: typeof destinationId === 'string' ? destinationId : null,
        schemaVersion: typeof schemaVersion === 'string' ? schemaVersion : null,
      };
    },
  );
}

/** Creates a subscription; answers its id (from the `Location` header). */
export function createNotificationSubscription(
  endpoints: Pick<RestEndpoints, 'api'>,
  request: SubscriptionRequest,
  options: RestRequestOptions,
): Promise<RestResult<string>> {
  return rest(
    'POST',
    `${endpoints.api}${BASE}/subscription`,
    options,
    (_body, headers) => lastPathSegment(headers.get('location')),
    { topicId: request.topicId, ...subscriptionBody(request) },
  );
}

export function updateNotificationSubscription(
  endpoints: Pick<RestEndpoints, 'api'>,
  subscriptionId: string,
  request: SubscriptionRequest,
  options: RestRequestOptions,
): Promise<RestResult<true>> {
  return rest(
    'PUT',
    `${endpoints.api}${BASE}/subscription/${encodeURIComponent(subscriptionId)}`,
    options,
    () => true,
    subscriptionBody(request),
  );
}

function destinationBody(request: DestinationRequest): Record<string, unknown> {
  return {
    name: request.name,
    status: request.status,
    deliveryConfig: { endpoint: request.endpoint, verificationToken: request.verificationToken },
  };
}

function subscriptionBody(request: SubscriptionRequest): Record<string, unknown> {
  return {
    destinationId: request.destinationId,
    status: request.status,
    payload: { format: 'JSON', schemaVersion: request.schemaVersion, deliveryProtocol: 'HTTPS' },
  };
}

/** Follows `next` links; at most 20 pages, which is far more than Listora ever holds. */
async function pages<T>(
  firstUrl: string,
  options: RestRequestOptions,
  field: string,
  read: (entry: Record<string, unknown>) => T | undefined,
): Promise<RestResult<T[]>> {
  const all: T[] = [];
  let url: string | null = firstUrl;
  for (let page = 0; url !== null && page < 20; page += 1) {
    const result: RestResult<{ items: T[]; next: string | null }> = await rest(
      'GET',
      url,
      options,
      (body) => {
        if (body === null) return { items: [], next: null };
        const { [field]: entries, next } = body as Record<string, unknown>;
        return {
          items: (Array.isArray(entries) ? entries : []).flatMap((entry: unknown) => {
            const value = read((entry ?? {}) as Record<string, unknown>);
            return value === undefined ? [] : [value];
          }),
          next: typeof next === 'string' && next !== '' ? next : null,
        };
      },
    );
    if (result.type !== 'ok') return result;
    all.push(...result.value.items);
    url = result.value.next;
  }
  return { type: 'ok', value: all };
}

function statusOf(value: unknown): NotificationStatus {
  return value === 'ENABLED' || value === 'DISABLED' || value === 'MARKED_DOWN' ? value : 'UNKNOWN';
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function lastPathSegment(location: string | null): string | undefined {
  if (location === null) return undefined;
  const segment = location.replace(/\/+$/, '').split('/').pop();
  return segment === undefined || segment === '' ? undefined : decodeURIComponent(segment);
}

/** `"1.10"` before `"1.9"` before `"1.0"`. */
function compareVersionsDescending(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0 && Number.isFinite(difference)) return difference;
  }
  return b.localeCompare(a);
}
