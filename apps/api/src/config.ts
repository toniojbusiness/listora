import { z } from 'zod';

import { AiConfigError, loadAiConfig, type AiConfig } from '@listora/ai';
import { LOG_LEVELS, type LogLevel } from '@listora/shared';
import { loadStorageConfig, StorageConfigError, type StorageConfig } from '@listora/storage';

/** Auth drivers this build can run. `cognito` arrives with plan task T-31. */
export const AUTH_DRIVERS = ['dev'] as const;
export type AuthDriverName = (typeof AUTH_DRIVERS)[number];

/** Shortest accepted AUTH_DEV_SECRET: 32 characters, about 256 bits when random. */
export const MIN_DEV_SECRET_LENGTH = 32;

export interface ApiConfig {
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: LogLevel;
  auth: {
    driver: AuthDriverName;
    /** HMAC key for dev session tokens; absent means a random key per process. */
    devSecret: string | undefined;
  };
  /** STORAGE_* keys, read by @listora/storage. */
  storage: StorageConfig;
  /** AI_* keys, read by @listora/ai: the guards analysis requests are checked against. */
  ai: AiConfig;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid API configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * The environment keys the API reads, in the order problems are reported. Each message names
 * the key but never its value, because values such as DATABASE_URL hold secrets; zod's own
 * messages are never used for the same reason.
 */
const envSchema = z.object({
  API_HOST: z.string({ error: 'API_HOST must be a host name or IP address' }).default('127.0.0.1'),
  API_PORT: z
    .string()
    .default('3000')
    .refine((value) => /^\d+$/.test(value) && Number(value) <= 65_535, {
      error: 'API_PORT must be an integer from 0 to 65535',
    })
    .transform(Number),
  AUTH_DRIVER: z.enum(AUTH_DRIVERS, {
    error: (issue) =>
      issue.input === undefined
        ? 'AUTH_DRIVER is required'
        : `AUTH_DRIVER must be one of ${AUTH_DRIVERS.join(', ')}`,
  }),
  AUTH_DEV_SECRET: z
    .string()
    .min(MIN_DEV_SECRET_LENGTH, {
      error: `AUTH_DEV_SECRET must be at least ${String(MIN_DEV_SECRET_LENGTH)} characters`,
    })
    .optional(),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .min(1, { error: 'DATABASE_URL is required', abort: true })
    .regex(/^postgres(ql)?:\/\//, { error: 'DATABASE_URL must be a postgres:// URL' }),
  LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}` })
    .default('info'),
});

/** Reads API settings from the environment (see `.env.example`) and reports every problem at once. */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = envSchema.safeParse(env);
  const issues = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  let storage: StorageConfig | undefined;
  try {
    storage = loadStorageConfig(env);
  } catch (error) {
    if (!(error instanceof StorageConfigError)) throw error;
    issues.push(...error.issues);
  }
  let ai: AiConfig | undefined;
  try {
    ai = loadAiConfig(env);
  } catch (error) {
    if (!(error instanceof AiConfigError)) throw error;
    issues.push(...error.issues);
  }
  if (!parsed.success || storage === undefined || ai === undefined) {
    throw new ConfigError(issues);
  }
  const values = parsed.data;
  return {
    host: values.API_HOST,
    port: values.API_PORT,
    databaseUrl: values.DATABASE_URL,
    logLevel: values.LOG_LEVEL,
    auth: { driver: values.AUTH_DRIVER, devSecret: values.AUTH_DEV_SECRET },
    storage,
    ai,
  };
}
