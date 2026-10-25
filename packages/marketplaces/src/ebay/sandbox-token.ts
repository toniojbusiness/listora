/**
 * `npm run ebay:sandbox-token`: gets an eBay sandbox seller's refresh token for the sandbox
 * check (and a single-seller worker), until eBay connect (T-16) does this in the app. It
 * prints eBay's consent URL; you sign in there as a sandbox test user and agree, then paste
 * the address of the page eBay shows. It exchanges the code and saves
 * `EBAY_USER_REFRESH_TOKEN` in `.env` without printing it.
 *
 * Needs `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, and `EBAY_RUNAME` (the sandbox keyset's
 * RuName) in `.env`. README.md, "eBay sandbox check", has the steps.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { EbayConfigError, loadEbayConfig } from './config.ts';
import { EBAY_USER_SCOPES, EbayOAuthClient, ebayConsentUrl } from './oauth.ts';

const ENV_FILE = fileURLToPath(new URL('../../../../.env', import.meta.url));

/** The authorization code in the URL eBay redirected to, after checking its `state`. */
export function codeFromRedirect(address: string, state: string): string {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new Error('That is not a URL. Paste the whole address of the page eBay showed.');
  }
  const code = url.searchParams.get('code');
  if (code === null || code === '') {
    throw new Error("That address has no code. Did you agree on eBay's page?");
  }
  if (url.searchParams.get('state') !== state) {
    throw new Error('That address is from another sign-in. Start again.');
  }
  return code;
}

/** `.env` text with `key` set to `value`: the existing line replaced, or one appended. */
export function withEnvValue(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*#?\\s*${key}=.*$`, 'm');
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`;
}

async function main(): Promise<void> {
  const ruName = process.env['EBAY_RUNAME'] ?? '';
  let config;
  try {
    config = loadEbayConfig({ ...process.env, EBAY_ENV: 'sandbox' });
  } catch (error) {
    if (!(error instanceof EbayConfigError)) throw error;
    process.stderr.write(`${error.message}\nSet them in .env (see .env.example).\n`);
    process.exit(1);
  }
  if (config === undefined || ruName === '') {
    process.stderr.write(
      "EBAY_RUNAME is required: the sandbox keyset's RuName (see .env.example).\n",
    );
    process.exit(1);
  }
  const state = randomUUID();
  const consent = ebayConsentUrl({
    authorizeUrl: config.endpoints.authorize,
    clientId: config.clientId,
    ruName,
    scopes: EBAY_USER_SCOPES,
    state,
  });
  process.stdout.write(
    `1. Open this URL and sign in with your eBay sandbox test user, then agree:\n\n${consent}\n\n` +
      '2. Paste the whole address of the page eBay shows next, and press Enter.\n\n',
  );
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const address = await prompt.question('Address: ');
  prompt.close();
  const oauth = new EbayOAuthClient({
    tokenUrl: config.endpoints.oauthToken,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
  const tokens = await oauth.exchangeAuthorizationCode(
    codeFromRedirect(address, state),
    ruName,
    AbortSignal.timeout(30_000),
  );
  const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  writeFileSync(ENV_FILE, withEnvValue(current, 'EBAY_USER_REFRESH_TOKEN', tokens.refreshToken));
  process.stdout.write(
    `\nSaved EBAY_USER_REFRESH_TOKEN in .env (it lasts until ${new Date(tokens.refreshExpiresAt).toDateString()}).\n` +
      'Now run: npm run ebay:sandbox-check\n',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
