import type { Logger } from '@listora/shared';

import { RecordingPushSender, type PushSender } from './sender.ts';

/** `fake` records and logs notifications; APNs joins with device registration. */
export const PUSH_DRIVERS = ['fake'] as const;
export type PushDriver = (typeof PUSH_DRIVERS)[number];

export interface PushConfig {
  readonly driver: PushDriver;
}

export class PushConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid push configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'PushConfigError';
    this.issues = issues;
  }
}

/** Reads `PUSH_DRIVER` (see `.env.example`), once at startup; unset or empty means `fake`. */
export function loadPushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig {
  const raw = env['PUSH_DRIVER'];
  const driver = raw === undefined || raw === '' ? 'fake' : raw;
  const known = PUSH_DRIVERS.find((candidate) => candidate === driver);
  if (known === undefined) {
    throw new PushConfigError([`PUSH_DRIVER must be one of ${PUSH_DRIVERS.join(', ')}`]);
  }
  return { driver: known };
}

/** The sender `config` selects. A new driver adds its case here. */
export function createPushSender(config: PushConfig, logger: Logger): PushSender {
  const driver: PushDriver = config.driver;
  return new RecordingPushSender({ logger: logger.child({ push: driver }) });
}
