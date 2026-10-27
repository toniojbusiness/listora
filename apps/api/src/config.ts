import { z } from 'zod';

import { USER_POOL_ID_PATTERN, userPoolRegion } from '@listora/accounts';
import { AiConfigError, loadAiConfig, type AiConfig } from '@listora/ai';
import {
  AutomationConfigError,
  loadAutomationSettings,
  type AutomationSettings,
} from '@listora/automation';
import {
  loadMarketplaceConfig,
  MarketplaceConfigError,
  type MarketplaceConfig,
} from '@listora/connections';
import { CONNECT_TIMEOUT_ISSUE, parseConnectTimeoutMs } from '@listora/db';
import {
  EmailIngestConfigError,
  loadEmailIngestConfig,
  type EmailIngestConfig,
} from '@listora/email-sales';
import { assertNever, LOG_LEVELS, type LogLevel } from '@listora/shared';
import { loadStorageConfig, StorageConfigError, type StorageConfig } from '@listora/storage';

import type { SignUpPolicy } from './tenancy.ts';

/** Auth drivers this build can run (`AUTH_DRIVER`). */
export const AUTH_DRIVERS = ['dev', 'cognito'] as const;
export type AuthDriverName = (typeof AUTH_DRIVERS)[number];

/** Who gets an account at their first sign-in (`SIGN_UP`, docs/features/invites.md). */
export const SIGN_UP_MODES = ['open', 'invite'] as const;
/**
 * How redeeming an invite makes sure the sign-in codes reach the invitee
 * (`INVITE_EMAIL_VERIFICATION`): `none` when the provider can send anywhere, `ses` while the
 * account's SES is in its sandbox (each invitee's address becomes a verified SES identity).
 */
export const INVITE_EMAIL_VERIFICATIONS = ['none', 'ses'] as const;
export type InviteEmailVerification = (typeof INVITE_EMAIL_VERIFICATIONS)[number];

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
  /** DATABASE_CONNECT_TIMEOUT_MS: how long opening a database connection may take. */
  databaseConnectTimeoutMs: number;
  logLevel: LogLevel;
  auth: AuthConfig;
  /** SIGN_UP and SIGN_UP_OWNER_EMAIL: who gets an account at their first sign-in. */
  signUp: SignUpPolicy;
  /** INVITE_EMAIL_VERIFICATION; `ses` only with the cognito driver. */
  inviteEmailVerification: InviteEmailVerification;
  /** STORAGE_* keys, read by @listora/storage. */
  storage: StorageConfig;
  /** AI_* keys, read by @listora/ai: the guards analysis requests are checked against. */
  ai: AiConfig;
  /**
   * FAKE_MARKETPLACE_URL, EBAY_*, and TOKEN_* keys, read by @listora/connections: which
   * marketplaces can be connected, and the token vault the API seals new grants and linked
   * marketplace sessions with (only the worker and the browser runner decrypt them).
   */
  marketplaces: MarketplaceConfig;
  /**
   * AUTOMATION_* and FAKE_AUTOMATION_SITE_URL (@listora/automation): each automated
   * marketplace's sign-in page and cookie domains, the same the worker and the runner use.
   */
  automation: AutomationSettings;
  /**
   * EMAIL_* (@listora/email-sales): the domain of the sale email forwarding addresses the API
   * shows, and with the folder driver the folder `POST /dev/email` drops messages in.
   */
  emailIngest: EmailIngestConfig;
  /**
   * OPERATION_RETRY_DELAY_SCALE: the operation engine's retry and confirmation delays, as the
   * worker's, for the steps phones run (the API records their results).
   */
  operationRetryDelayScale: number;
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
  SIGN_UP: z
    .enum(SIGN_UP_MODES, { error: `SIGN_UP must be one of ${SIGN_UP_MODES.join(', ')}` })
    .default('open'),
  SIGN_UP_OWNER_EMAIL: z
    .email({ error: 'SIGN_UP_OWNER_EMAIL must be an email address' })
    .transform((value) => value.toLowerCase())
    .optional(),
  INVITE_EMAIL_VERIFICATION: z
    .enum(INVITE_EMAIL_VERIFICATIONS, {
      error: `INVITE_EMAIL_VERIFICATION must be one of ${INVITE_EMAIL_VERIFICATIONS.join(', ')}`,
    })
    .default('none'),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .min(1, { error: 'DATABASE_URL is required', abort: true })
    .regex(/^postgres(ql)?:\/\//, { error: 'DATABASE_URL must be a postgres:// URL' }),
  DATABASE_CONNECT_TIMEOUT_MS: z
    .string()
    .optional()
    .transform(parseConnectTimeoutMs)
    .refine((value) => value !== undefined, { error: CONNECT_TIMEOUT_ISSUE }),
  LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}` })
    .default('info'),
  OPERATION_RETRY_DELAY_SCALE: z
    .string()
    .default('')
    .transform((value) => (value === '' ? 1 : Number(value)))
    .refine((value) => value >= 0.001 && value <= 1, {
      error: 'OPERATION_RETRY_DELAY_SCALE must be a number from 0.001 to 1',
    }),
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
  let automation: AutomationSettings | undefined;
  try {
    automation = loadAutomationSettings(env);
  } catch (error) {
    if (!(error instanceof AutomationConfigError)) throw error;
    issues.push(...error.issues);
  }
  let emailIngest: EmailIngestConfig | undefined;
  try {
    emailIngest = loadEmailIngestConfig(env);
  } catch (error) {
    if (!(error instanceof EmailIngestConfigError)) throw error;
    issues.push(...error.issues);
  }
  if (
    !parsed.success ||
    storage === undefined ||
    ai === undefined ||
    marketplaces === undefined ||
    automation === undefined ||
    emailIngest === undefined
  ) {
    throw new ConfigError(issues);
  }
  const values = parsed.data;
  const auth = authConfig(values);
  if (Array.isArray(auth)) throw new ConfigError(auth);
  const signUpIssues = [
    ...(values.SIGN_UP_OWNER_EMAIL !== undefined && values.SIGN_UP !== 'invite'
      ? ['SIGN_UP_OWNER_EMAIL is only for SIGN_UP=invite']
      : []),
    ...(values.INVITE_EMAIL_VERIFICATION === 'ses' && auth.driver !== 'cognito'
      ? ['INVITE_EMAIL_VERIFICATION=ses needs AUTH_DRIVER=cognito']
      : []),
  ];
  if (signUpIssues.length > 0) throw new ConfigError(signUpIssues);
  return {
    host: values.API_HOST,
    port: values.API_PORT,
    databaseUrl: values.DATABASE_URL,
    databaseConnectTimeoutMs: values.DATABASE_CONNECT_TIMEOUT_MS,
    logLevel: values.LOG_LEVEL,
    auth,
    signUp:
      values.SIGN_UP === 'invite'
        ? { mode: 'invite', ownerEmail: values.SIGN_UP_OWNER_EMAIL }
        : { mode: 'open' },
    inviteEmailVerification: values.INVITE_EMAIL_VERIFICATION,
    storage,
    ai,
    marketplaces,
    automation,
    emailIngest,
    operationRetryDelayScale: values.OPERATION_RETRY_DELAY_SCALE,
  };
}
