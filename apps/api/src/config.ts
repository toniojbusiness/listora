import { z } from 'zod';

import { USER_POOL_ID_PATTERN, userPoolRegion } from '@listora/accounts';
import { AiConfigError, loadAiConfig, type AiConfig } from '@listora/ai';
import {
  loadMarketplaceConfig,
  MarketplaceConfigError,
  type MarketplaceConfig,
} from '@listora/connections';
import { assertNever, LOG_LEVELS, type LogLevel } from '@listora/shared';
import { loadStorageConfig, StorageConfigError, type StorageConfig } from '@listora/storage';

/** Auth drivers this build can run (`AUTH_DRIVER`). */
export const AUTH_DRIVERS = ['dev', 'cognito'] as const;
export type AuthDriverName = (typeof AUTH_DRIVERS)[number];

/** Shortest accepted AUTH_DEV_SECRET: 32 characters, about 256 bits when random. */
export const MIN_DEV_SECRET_LENGTH = 32;

/** A Cognito app client id: 1-128 word characters (in practice 26 lowercase alphanumerics). */
const APP_CLIENT_ID = /^[\w+]{1,128}$/;

export interface CognitoConfig {
  /** The AWS region of the user pool, taken from its id. */
  region: string;
  userPoolId: string;
  /** App clients whose tokens the API accepts (the iPhone app's, later the web app's). */
  clientIds: readonly string[];
}

export type AuthConfig =
  | {
      driver: 'dev';
      /** HMAC key for dev session tokens; absent means a random key per process. */
      devSecret: string | undefined;
    }
  | { driver: 'cognito'; cognito: CognitoConfig };

export interface ApiConfig {
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: LogLevel;
  auth: AuthConfig;
  /** STORAGE_* keys, read by @listora/storage. */
  storage: StorageConfig;
  /** AI_* keys, read by @listora/ai: the guards analysis requests are checked against. */
  ai: AiConfig;
  /**
   * FAKE_MARKETPLACE_URL, EBAY_*, and TOKEN_* keys, read by @listora/connections: which
   * marketplaces can be connected, and the token vault the API seals new grants with.
   */
  marketplaces: MarketplaceConfig;
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
  COGNITO_USER_POOL_ID: z
    .string()
    .regex(USER_POOL_ID_PATTERN, {
      error: 'COGNITO_USER_POOL_ID must be a user pool id such as us-east-1_AbC123xyZ',
    })
    .optional(),
  COGNITO_CLIENT_IDS: z
    .string()
    .transform((value) => value.split(',').map((id) => id.trim()))
    .refine((ids) => ids.every((id) => APP_CLIENT_ID.test(id)), {
      error: 'COGNITO_CLIENT_IDS must be a comma-separated list of app client ids',
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
type Env = z.infer<typeof envSchema>;

/** Keys only one auth driver reads, required when that driver is selected. */
function authConfig(values: Env): AuthConfig | string[] {
  switch (values.AUTH_DRIVER) {
    case 'dev':
      return { driver: 'dev', devSecret: values.AUTH_DEV_SECRET };
    case 'cognito': {
      const { COGNITO_USER_POOL_ID: userPoolId, COGNITO_CLIENT_IDS: clientIds } = values;
      if (userPoolId === undefined || clientIds === undefined) {
        return [
          ...(userPoolId === undefined ? ['COGNITO_USER_POOL_ID'] : []),
          ...(clientIds === undefined ? ['COGNITO_CLIENT_IDS'] : []),
        ].map((key) => `${key} is required when AUTH_DRIVER=cognito`);
      }
      return {
        driver: 'cognito',
        cognito: { region: userPoolRegion(userPoolId), userPoolId, clientIds },
      };
    }
    default:
      return assertNever(values.AUTH_DRIVER, 'AUTH_DRIVER');
  }
}

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
  let marketplaces: MarketplaceConfig | undefined;
  try {
    marketplaces = loadMarketplaceConfig(env);
  } catch (error) {
    if (!(error instanceof MarketplaceConfigError)) throw error;
    issues.push(...error.issues);
  }
  if (!parsed.success || storage === undefined || ai === undefined || marketplaces === undefined) {
    throw new ConfigError(issues);
  }
  const values = parsed.data;
  const auth = authConfig(values);
  if (Array.isArray(auth)) throw new ConfigError(auth);
  return {
    host: values.API_HOST,
    port: values.API_PORT,
    databaseUrl: values.DATABASE_URL,
    logLevel: values.LOG_LEVEL,
    auth,
    storage,
    ai,
    marketplaces,
  };
}
