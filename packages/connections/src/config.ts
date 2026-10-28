/**
 * Marketplace settings (`.env.example`). The token vault uses `TOKEN_KMS_KEY_ID` (deployed:
 * KMS envelope encryption) or `TOKEN_ENCRYPTION_KEY` (development: a local key), never both.
 * Without either, the process has no vault, and Listora cannot connect marketplace accounts
 * (and says so).
 */
import {
  DepopConfigError,
  EbayConfigError,
  EbayConnectClient,
  loadDepopConfig,
  loadEbayConfig,
  loadMarketplaceFeatures,
  MarketplaceFeaturesConfigError,
  type DepopConfig,
  type EbayConfig,
  type MarketplaceFeatureSet,
  type OAuthClients,
} from '@listora/marketplaces';

import { KmsTokenVault } from './kms-vault.ts';
import { LocalTokenVault } from './local-vault.ts';
import { DATA_KEY_BYTES, type TokenVault } from './vault.ts';

export type TokenVaultConfig =
  | { driver: 'kms'; keyId: string; region: string | undefined }
  /** `key` is a secret: never logged. */
  | { driver: 'local'; key: Buffer };

export class TokenVaultConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid token vault configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'TokenVaultConfigError';
    this.issues = issues;
  }
}

/** A KMS key ARN (`arn:aws:kms:<region>:<account>:key/<id>`), whose region the client uses. */
const KEY_ARN = /^arn:aws[a-z-]*:kms:([a-z]{2}(?:-[a-z]+)+-\d+):\d{12}:(?:key|alias)\/[\w/-]+$/;
const KEY_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|alias\/[\w/-]+)$/;

/**
 * Reads the vault settings from the environment, once at startup. Errors name the bad key but
 * never echo its value.
 */
export function loadTokenVaultConfig(
  env: NodeJS.ProcessEnv = process.env,
): TokenVaultConfig | undefined {
  const keyId = nonEmpty(env['TOKEN_KMS_KEY_ID']);
  const localKey = nonEmpty(env['TOKEN_ENCRYPTION_KEY']);
  if (keyId !== undefined && localKey !== undefined) {
    throw new TokenVaultConfigError(['set TOKEN_KMS_KEY_ID or TOKEN_ENCRYPTION_KEY, not both']);
  }
  if (keyId !== undefined) {
    const arn = KEY_ARN.exec(keyId);
    if (arn === null && !KEY_ID.test(keyId)) {
      throw new TokenVaultConfigError([
        'TOKEN_KMS_KEY_ID must be a KMS key ARN, key id, or alias/<name>',
      ]);
    }
    return { driver: 'kms', keyId, region: arn?.[1] };
  }
  if (localKey !== undefined) {
    const key = Buffer.from(localKey, 'base64');
    if (key.length !== DATA_KEY_BYTES || key.toString('base64') !== localKey) {
      throw new TokenVaultConfigError([
        `TOKEN_ENCRYPTION_KEY must be ${String(DATA_KEY_BYTES)} bytes in base64 (openssl rand -base64 32)`,
      ]);
    }
    return { driver: 'local', key };
  }
  return undefined;
}

export function createTokenVault(config: TokenVaultConfig): TokenVault {
  return config.driver === 'kms'
    ? new KmsTokenVault({
        keyId: config.keyId,
        ...(config.region === undefined ? {} : { client: { region: config.region } }),
      })
    : new LocalTokenVault(config.key);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Everything a process needs about marketplaces (`.env.example`): the fake marketplace, the
 * eBay and Depop settings, and the token vault. The API and the worker read the same keys, so they always
 * agree on which marketplaces can connect.
 */
export interface MarketplaceConfig {
  /** `FAKE_MARKETPLACE_URL` (development and tests only). */
  fakeMarketplaceUrl: string | undefined;
  /** `EBAY_*`; undefined when eBay is not configured. Connecting also needs `EBAY_RUNAME`. */
  ebay: EbayConfig | undefined;
  /** `DEPOP_*`; undefined when Depop runs assisted only (until Listora's partner access). */
  depop: DepopConfig | undefined;
  /** `TOKEN_*`; without it no marketplace account can be connected (and the app says so). */
  tokenVault: TokenVaultConfig | undefined;
  /**
   * `MARKETPLACE_FEATURES`: only the features that passed live (`verified`, every deployment),
   * or every one built (`all`, the fakes) (docs/features/verified-features.md).
   */
  features: MarketplaceFeatureSet;
}

export class MarketplaceConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid marketplace configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'MarketplaceConfigError';
    this.issues = issues;
  }
}

export function loadMarketplaceConfig(env: NodeJS.ProcessEnv = process.env): MarketplaceConfig {
  const issues: string[] = [];
  const fakeMarketplaceUrl = nonEmpty(env['FAKE_MARKETPLACE_URL']);
  if (fakeMarketplaceUrl !== undefined && !/^https?:\/\/[^\s]+$/.test(fakeMarketplaceUrl)) {
    issues.push('FAKE_MARKETPLACE_URL must be an http:// or https:// URL');
  }
  let ebay: EbayConfig | undefined;
  try {
    ebay = loadEbayConfig(env);
  } catch (error) {
    if (!(error instanceof EbayConfigError)) throw error;
    issues.push(...error.issues);
  }
  let depop: DepopConfig | undefined;
  try {
    depop = loadDepopConfig(env);
  } catch (error) {
    if (!(error instanceof DepopConfigError)) throw error;
    issues.push(...error.issues);
  }
  let tokenVault: TokenVaultConfig | undefined;
  try {
    tokenVault = loadTokenVaultConfig(env);
  } catch (error) {
    if (!(error instanceof TokenVaultConfigError)) throw error;
    issues.push(...error.issues);
  }
  let features: MarketplaceFeatureSet = 'verified';
  try {
    features = loadMarketplaceFeatures(env);
  } catch (error) {
    if (!(error instanceof MarketplaceFeaturesConfigError)) throw error;
    issues.push(...error.issues);
  }
  if (issues.length > 0) throw new MarketplaceConfigError(issues);
  return { fakeMarketplaceUrl, ebay, depop, tokenVault, features };
}

/** The OAuth clients of the marketplaces this configuration can connect. */
export function createOAuthClients(config: Pick<MarketplaceConfig, 'ebay'>): OAuthClients {
  const ebay = config.ebay === undefined ? undefined : EbayConnectClient.fromConfig(config.ebay);
  return ebay === undefined ? {} : { ebay };
}
