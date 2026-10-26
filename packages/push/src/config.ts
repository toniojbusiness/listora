import { createPrivateKey } from 'node:crypto';

import type { Db } from '@listora/db';
import type { Logger } from '@listora/shared';

import { APNS_ENDPOINTS, ApnsPushSender, type ApnsConfig } from './apns.ts';
import { PostgresDeviceDirectory } from './devices.ts';
import { RecordingPushSender, type PushSender } from './sender.ts';

/** `fake` records and logs notifications; `apns` sends them through Apple's push service. */
export const PUSH_DRIVERS = ['fake', 'apns'] as const;
export type PushDriver = (typeof PUSH_DRIVERS)[number];

export type PushConfig =
  { readonly driver: 'fake' } | { readonly driver: 'apns'; readonly apns: ApnsConfig };

export class PushConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid push configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'PushConfigError';
    this.issues = issues;
  }
}

/**
 * Reads `PUSH_DRIVER` and, for `apns`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, and
 * `APNS_TOPIC` (see `.env.example`), once at startup; unset or empty means `fake`. A message
 * names a bad key but never prints its value.
 */
export function loadPushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig {
  const raw = env['PUSH_DRIVER'];
  const driver = raw === undefined || raw === '' ? 'fake' : raw;
  const known = PUSH_DRIVERS.find((candidate) => candidate === driver);
  if (known === undefined) {
    throw new PushConfigError([`PUSH_DRIVER must be one of ${PUSH_DRIVERS.join(', ')}`]);
  }
  if (known === 'fake') return { driver: 'fake' };
  const issues: string[] = [];
  const required = (key: string, pattern: RegExp, what: string): string => {
    const value = env[key]?.trim() ?? '';
    if (!pattern.test(value)) issues.push(`${key} must be ${what}`);
    return value;
  };
  const keyId = required('APNS_KEY_ID', /^[A-Z0-9]{10}$/, 'the 10-character APNs key id');
  const teamId = required('APNS_TEAM_ID', /^[A-Z0-9]{10}$/, 'the 10-character Apple team id');
  // A key from an environment variable may have its line breaks escaped.
  const privateKey = (env['APNS_PRIVATE_KEY'] ?? '').replaceAll('\\n', '\n').trim();
  if (!isApnsKey(privateKey)) issues.push('APNS_PRIVATE_KEY must be the APNs .p8 key (PEM)');
  const topic = required('APNS_TOPIC', /^[A-Za-z0-9.-]+$/, "the app's bundle id");
  if (issues.length > 0) throw new PushConfigError(issues);
  return { driver: 'apns', apns: { keyId, teamId, privateKey, topic, endpoints: APNS_ENDPOINTS } };
}

/** Whether `pem` is an elliptic-curve private key, as Apple's `.p8` provider keys are. */
function isApnsKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === 'ec';
  } catch {
    return false;
  }
}

/** The sender `config` selects. A new driver adds its case here. */
export function createPushSender(config: PushConfig, logger: Logger, db?: Db): PushSender {
  switch (config.driver) {
    case 'fake':
      return new RecordingPushSender({ logger: logger.child({ push: 'fake' }) });
    case 'apns':
      if (db === undefined)
        throw new Error('the APNs driver reads device tokens from the database');
      return new ApnsPushSender(config.apns, new PostgresDeviceDirectory(db), logger);
  }
}
