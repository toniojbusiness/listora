import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createOAuthClients,
  createTokenVault,
  loadMarketplaceConfig,
  loadTokenVaultConfig,
  TokenVaultConfigError,
  type MarketplaceConfigError,
} from './config.ts';
import { KmsTokenVault } from './kms-vault.ts';
import { LocalTokenVault } from './local-vault.ts';
import { FakeKms } from './testing.ts';
import {
  CREDENTIAL_PURPOSES,
  sealOnly,
  TokenVaultError,
  type TokenContext,
  type TokenVault,
} from './vault.ts';

const TOKENS = {
  accessToken: 'v^1.1#i^1#p^3#r^0#access-secret-value',
  refreshToken: 'v^1.1#i^1#p^3#r^1#refresh-secret-value',
};
const CONTEXT: TokenContext = {
  marketplace: 'ebay',
  connectionId: '0199a1f0-0000-7000-8000-00000000c001',
};

function behavesLikeAVault(name: string, make: () => TokenVault) {
  describe(name, () => {
    it('seals tokens so they open again only for the same connection', async () => {
      const vault = make();
      const sealed = await vault.seal(TOKENS, CONTEXT);
      expect(await vault.open(sealed, CONTEXT)).toEqual(TOKENS);
      await expect(
        vault.open(sealed, { ...CONTEXT, connectionId: '0199a1f0-0000-7000-8000-00000000c002' }),
      ).rejects.toMatchObject({ name: 'TokenVaultError', kind: 'corrupt' });
      await expect(vault.open(sealed, { ...CONTEXT, marketplace: 'depop' })).rejects.toThrow(
        TokenVaultError,
      );
    });

    it('never holds the tokens in plain text, and uses a new data key every time', async () => {
      const vault = make();
      const first = await vault.seal(TOKENS, CONTEXT);
      const second = await vault.seal(TOKENS, CONTEXT);
      expect(first.equals(second)).toBe(false);
      for (const sealed of [first, second]) {
        const text = sealed.toString('latin1');
        expect(text).not.toContain('secret-value');
        expect(text).not.toContain(Buffer.from('secret-value').toString('base64'));
      }
    });

    it('seals browser sessions apart from tokens: neither kind ever opens as the other', async () => {
      const vault = make();
      const session = Buffer.from('{"cookies":[{"name":"sid","value":"session-secret-value"}]}');
      const sealedSession = await vault.sealSession(session, CONTEXT);
      expect((await vault.openSession(sealedSession, CONTEXT)).equals(session)).toBe(true);
      expect(sealedSession.toString('latin1')).not.toContain('secret-value');
      await expect(vault.open(sealedSession, CONTEXT)).rejects.toMatchObject({ kind: 'corrupt' });
      await expect(
        vault.openSession(await vault.seal(TOKENS, CONTEXT), CONTEXT),
      ).rejects.toMatchObject({ kind: 'corrupt' });
      await expect(
        vault.openSession(sealedSession, {
          ...CONTEXT,
          connectionId: '0199a1f0-0000-7000-8000-00000000c002',
        }),
      ).rejects.toMatchObject({ kind: 'corrupt' });
    });

    it('refuses a damaged or foreign ciphertext as corrupt', async () => {
      const vault = make();
      const sealed = await vault.seal(TOKENS, CONTEXT);
      const flipped = Buffer.from(sealed);
      flipped[flipped.length - 1] = (flipped.at(-1) ?? 0) ^ 1;
      await expect(vault.open(flipped, CONTEXT)).rejects.toMatchObject({ kind: 'corrupt' });
      await expect(vault.open(sealed.subarray(0, 20), CONTEXT)).rejects.toMatchObject({
        kind: 'corrupt',
      });
      await expect(vault.open(Buffer.from('ciphertext'), CONTEXT)).rejects.toMatchObject({
        kind: 'corrupt',
      });
    });
  });
}

behavesLikeAVault('LocalTokenVault', () => new LocalTokenVault(randomBytes(32)));

describe('LocalTokenVault keys', () => {
  it('says a ciphertext was sealed under another local key', async () => {
    const sealed = await new LocalTokenVault(randomBytes(32)).seal(TOKENS, CONTEXT);
    await expect(new LocalTokenVault(randomBytes(32)).open(sealed, CONTEXT)).rejects.toThrow(
      'sealed under another local key',
    );
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => new LocalTokenVault(randomBytes(16))).toThrow('32 bytes');
  });
});

describe('KmsTokenVault against a fake KMS', () => {
  let kms: FakeKms;

  beforeAll(async () => {
    kms = await FakeKms.start();
  });

  afterAll(async () => {
    await kms.close();
  });

  behavesLikeAVault(
    'KmsTokenVault',
    () => new KmsTokenVault({ keyId: kms.keyId, client: kms.clientConfig }),
  );

  it('asks KMS for a data key per seal and to decrypt it per open, with the connection as context', async () => {
    const vault = new KmsTokenVault({ keyId: kms.keyId, client: kms.clientConfig });
    kms.calls.length = 0;
    const sealed = await vault.seal(TOKENS, CONTEXT);
    await vault.open(sealed, CONTEXT);
    expect(kms.calls).toEqual(['GenerateDataKey', 'Decrypt']);
  });

  it('reports a KMS outage as unavailable, so callers retry instead of asking to reconnect', async () => {
    const vault = new KmsTokenVault({
      keyId: kms.keyId,
      client: { ...kms.clientConfig, maxAttempts: 1 },
    });
    const sealed = await vault.seal(TOKENS, CONTEXT);
    kms.failNext = 'KMSInternalException';
    await expect(vault.open(sealed, CONTEXT)).rejects.toMatchObject({ kind: 'unavailable' });
    kms.failNext = 'KMSInternalException';
    await expect(vault.seal(TOKENS, CONTEXT)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('does not open a ciphertext the local key sealed, or the reverse', async () => {
    const kmsVault = new KmsTokenVault({ keyId: kms.keyId, client: kms.clientConfig });
    const local = new LocalTokenVault(randomBytes(32));
    await expect(kmsVault.open(await local.seal(TOKENS, CONTEXT), CONTEXT)).rejects.toMatchObject({
      kind: 'corrupt',
    });
    await expect(local.open(await kmsVault.seal(TOKENS, CONTEXT), CONTEXT)).rejects.toMatchObject({
      kind: 'corrupt',
    });
  });
});

describe('sealOnly', () => {
  it('hands out only the seals', async () => {
    const vault = new LocalTokenVault(randomBytes(32));
    const sealer = sealOnly(vault);
    expect(Object.keys(sealer)).toEqual(['seal', 'sealSession']);
    expect(await vault.open(await sealer.seal(TOKENS, CONTEXT), CONTEXT)).toEqual(TOKENS);
    const session = Buffer.from('{"cookies":[]}');
    const sealed = await sealer.sealSession(session, CONTEXT);
    expect((await vault.openSession(sealed, CONTEXT)).equals(session)).toBe(true);
  });
});

describe('CREDENTIAL_PURPOSES', () => {
  it("names each kind's KMS purpose, which infra's IAM conditions key on", () => {
    expect(CREDENTIAL_PURPOSES).toEqual({
      tokens: 'listora-marketplace-tokens',
      session: 'listora-marketplace-session',
    });
  });
});

describe('loadTokenVaultConfig', () => {
  const key = randomBytes(32).toString('base64');

  it('has no vault without a key', () => {
    expect(loadTokenVaultConfig({})).toBeUndefined();
    expect(
      loadTokenVaultConfig({ TOKEN_KMS_KEY_ID: '', TOKEN_ENCRYPTION_KEY: '' }),
    ).toBeUndefined();
  });

  it("uses the local key in development and KMS (with the ARN's region) when deployed", () => {
    const local = loadTokenVaultConfig({ TOKEN_ENCRYPTION_KEY: key });
    expect(local?.driver).toBe('local');
    expect(createTokenVault(local ?? { driver: 'local', key: Buffer.alloc(32) })).toBeInstanceOf(
      LocalTokenVault,
    );
    const arn = 'arn:aws:kms:eu-west-2:111122223333:key/0b6f7b3e-0000-4000-8000-000000000001';
    expect(loadTokenVaultConfig({ TOKEN_KMS_KEY_ID: arn })).toEqual({
      driver: 'kms',
      keyId: arn,
      region: 'eu-west-2',
    });
    expect(loadTokenVaultConfig({ TOKEN_KMS_KEY_ID: 'alias/listora-prod-tokens' })).toEqual({
      driver: 'kms',
      keyId: 'alias/listora-prod-tokens',
      region: undefined,
    });
  });

  it('refuses a bad or doubled setting without echoing the key', () => {
    const attempts = [
      { TOKEN_ENCRYPTION_KEY: 'too-short' },
      { TOKEN_ENCRYPTION_KEY: randomBytes(16).toString('base64') },
      { TOKEN_KMS_KEY_ID: 'not a key' },
      { TOKEN_ENCRYPTION_KEY: key, TOKEN_KMS_KEY_ID: 'alias/x' },
    ];
    for (const env of attempts) {
      let error: unknown;
      try {
        loadTokenVaultConfig(env);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TokenVaultConfigError);
      expect(String(error)).not.toContain(key);
    }
  });
});

describe('loadMarketplaceConfig', () => {
  const key = randomBytes(32).toString('base64');

  it('connects nothing by default', () => {
    expect(loadMarketplaceConfig({})).toEqual({
      fakeMarketplaceUrl: undefined,
      ebay: undefined,
      depop: undefined,
      tokenVault: undefined,
    });
  });

  it('reads eBay with or without a token vault, and connects eBay when its RuName is known', () => {
    expect(
      loadMarketplaceConfig({ EBAY_ENV: 'fake', EBAY_FAKE_URL: 'http://127.0.0.1:4110' })
        .tokenVault,
    ).toBeUndefined();
    const config = loadMarketplaceConfig({
      EBAY_ENV: 'fake',
      EBAY_FAKE_URL: 'http://127.0.0.1:4110',
      TOKEN_ENCRYPTION_KEY: key,
    });
    expect(config.ebay?.environment).toBe('fake');
    expect(Object.keys(createOAuthClients(config))).toEqual(['ebay']);
  });

  it('reports every problem at once', () => {
    let error: unknown;
    try {
      loadMarketplaceConfig({
        FAKE_MARKETPLACE_URL: 'ftp://x',
        EBAY_ENV: 'live',
        TOKEN_ENCRYPTION_KEY: 'x',
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as MarketplaceConfigError).issues).toEqual([
      'FAKE_MARKETPLACE_URL must be an http:// or https:// URL',
      'EBAY_ENV must be one of fake, sandbox, production',
      'TOKEN_ENCRYPTION_KEY must be 32 bytes in base64 (openssl rand -base64 32)',
    ]);
  });
});
