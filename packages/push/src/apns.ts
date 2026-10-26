/**
 * The APNs driver (`PUSH_DRIVER=apns`): Apple's push service over HTTP/2 with a token-based
 * provider key (a `.p8` signing key, its key id, and the team id), to every device token the
 * account's devices registered. A notification is an alert (`time_sensitive` breaks through
 * Focus); one that `wakesApp` also carries `content-available` so the app can run work that
 * waits for the phone. A background push is `content-available` alone. A token APNs refuses as
 * gone (410, `BadDeviceToken`) is forgotten; a send that fails otherwise throws, so the outbox
 * job runs again.
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';

import type { PushEnvironment } from '@listora/db';
import type { Logger } from '@listora/shared';

import type { BackgroundPush } from './background.ts';
import type { DeviceDirectory, DeviceToken } from './devices.ts';
import type { PushNotification } from './notification.ts';
import type { PushSender } from './sender.ts';

export interface ApnsConfig {
  /** The provider key's id (`APNS_KEY_ID`). */
  readonly keyId: string;
  /** The Apple developer team id (`APNS_TEAM_ID`). */
  readonly teamId: string;
  /** The `.p8` key, PEM (`APNS_PRIVATE_KEY`). */
  readonly privateKey: string;
  /** The app's bundle id (`APNS_TOPIC`). */
  readonly topic: string;
  /** Where each environment's pushes go (Apple's; tests point both at a fake). */
  readonly endpoints: Readonly<Record<PushEnvironment, string>>;
}

export const APNS_ENDPOINTS: Readonly<Record<PushEnvironment, string>> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};

/** APNs accepts a provider token for an hour; a new one is made well before. */
const TOKEN_LIFETIME_MS = 50 * 60_000;
/** The reasons APNs gives for a token that will never take a push again. */
const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

export class ApnsPushSender implements PushSender {
  readonly #config: ApnsConfig;
  readonly #key: KeyObject;
  readonly #devices: DeviceDirectory;
  readonly #log: Logger;
  #token: { value: string; madeAt: number } | null = null;
  readonly #sessions = new Map<string, ClientHttp2Session>();

  constructor(config: ApnsConfig, devices: DeviceDirectory, logger: Logger) {
    this.#config = config;
    this.#key = createPrivateKey(config.privateKey);
    this.#devices = devices;
    this.#log = logger.child({ push: 'apns' });
  }

  async send(notification: PushNotification, signal: AbortSignal): Promise<void> {
    const aps = {
      alert: { title: notification.title, body: notification.body },
      sound: 'default',
      'interruption-level': notification.urgency === 'time_sensitive' ? 'time-sensitive' : 'active',
      category: notification.category,
      ...(notification.threadId === null ? {} : { 'thread-id': notification.threadId }),
      ...(notification.wakesApp === true ? { 'content-available': 1 } : {}),
    };
    await this.#toAll(
      notification.accountId,
      { aps, ...notification.data },
      { type: 'alert', priority: 10 },
      signal,
    );
  }

  async sendBackground(push: BackgroundPush, signal: AbortSignal): Promise<void> {
    await this.#toAll(
      push.accountId,
      { aps: { 'content-available': 1 }, reason: push.reason },
      { type: 'background', priority: 5 },
      signal,
    );
  }

  /** Closes the HTTP/2 connections. */
  close(): void {
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
  }

  async #toAll(
    accountId: string,
    payload: Record<string, unknown>,
    kind: { type: 'alert' | 'background'; priority: 10 | 5 },
    signal: AbortSignal,
  ): Promise<void> {
    const tokens = await this.#devices.tokensFor(accountId);
    const body = JSON.stringify(payload);
    let failure: Error | null = null;
    for (const device of tokens) {
      try {
        await this.#post(device, body, kind, signal);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    }
    // Every device was tried; one that failed for a reason that clears sends again later.
    if (failure !== null) throw failure;
  }

  async #post(
    device: DeviceToken,
    body: string,
    kind: { type: 'alert' | 'background'; priority: 10 | 5 },
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.#session(device.environment);
    const { status, reason } = await new Promise<{ status: number; reason: string | null }>(
      (resolve, reject) => {
        const request = session.request(
          {
            ':method': 'POST',
            ':path': `/3/device/${device.token}`,
            authorization: `bearer ${this.#providerToken()}`,
            'apns-topic': this.#config.topic,
            'apns-push-type': kind.type,
            'apns-priority': String(kind.priority),
            'content-type': 'application/json',
          },
          { signal },
        );
        let responseStatus = 0;
        const chunks: Buffer[] = [];
        request.on('response', (headers) => {
          responseStatus = Number(headers[':status']);
        });
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: string | null = null;
          if (text !== '') {
            try {
              const json = JSON.parse(text) as { reason?: unknown };
              parsed = typeof json.reason === 'string' ? json.reason : null;
            } catch {
              parsed = null;
            }
          }
          resolve({ status: responseStatus, reason: parsed });
        });
        request.on('error', reject);
        request.end(body);
      },
    );
    if (status === 200) return;
    if (status === 410 || (reason !== null && GONE_REASONS.has(reason))) {
      // Never the token itself in a log line: it addresses the seller's phone.
      this.#log.info({ status, reason }, 'a device token is no longer valid; forgetting it');
      await this.#devices.forget(device.token);
      return;
    }
    if (status === 403 && reason === 'ExpiredProviderToken') this.#token = null;
    throw new Error(`APNs answered ${String(status)}${reason === null ? '' : ` (${reason})`}`);
  }

  #session(environment: PushEnvironment): ClientHttp2Session {
    const open = this.#sessions.get(environment);
    if (open !== undefined && !open.closed && !open.destroyed) return open;
    const session = connect(this.#config.endpoints[environment]);
    session.on('error', (error) => {
      this.#log.warn({ err: error }, 'the APNs connection failed');
      this.#sessions.delete(environment);
    });
    session.on('close', () => this.#sessions.delete(environment));
    // A connection with nothing in flight must not keep the worker alive.
    session.unref();
    this.#sessions.set(environment, session);
    return session;
  }

  /** The provider token: an ES256 JWT naming the key and the team. */
  #providerToken(): string {
    const now = Date.now();
    if (this.#token !== null && now - this.#token.madeAt < TOKEN_LIFETIME_MS) {
      return this.#token.value;
    }
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'ES256', kid: this.#config.keyId })}.${encode({
      iss: this.#config.teamId,
      iat: Math.floor(now / 1000),
    })}`;
    const signature = sign('sha256', Buffer.from(unsigned), {
      key: this.#key,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const value = `${unsigned}.${signature}`;
    this.#token = { value, madeAt: now };
    return value;
  }
}
