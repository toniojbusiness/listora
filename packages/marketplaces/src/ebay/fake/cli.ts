/**
 * Runs the fake eBay for local development: `npm run dev:fake-ebay`. It listens on 127.0.0.1
 * at the port of EBAY_FAKE_URL (see `.env.example`), the URL the worker's eBay adapter uses
 * with `EBAY_ENV=fake`. Its consent page sends the browser to EBAY_FAKE_CALLBACK_URL, the API's
 * eBay callback. Its state lives in memory and is lost when it stops.
 *
 * Local photo storage serves listing photos over http, and the local API receives notifications
 * over http, neither of which eBay accepts, so this development server accepts http photo URLs
 * and notification endpoints; tests use the fake with eBay's https rules unless they opt out.
 */
import { createLogger, handleShutdownSignals } from '@listora/shared';

import { DEFAULT_EBAY_FAKE_URL } from '../config.ts';
import { FakeEbay } from './fake-ebay.ts';

const logger = createLogger({ service: 'fake-ebay', level: 'info' });
const configured = process.env['EBAY_FAKE_URL'];
const url = new URL(
  configured === undefined || configured === '' ? DEFAULT_EBAY_FAKE_URL : configured,
);
if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
  logger.error('EBAY_FAKE_URL must point at http://127.0.0.1 or http://localhost');
  process.exit(1);
}

// Where the consent page sends the browser: the API's eBay callback.
const callback = process.env['EBAY_FAKE_CALLBACK_URL'];
const acceptUrl =
  callback === undefined || callback === ''
    ? 'http://127.0.0.1:3000/v1/connections/ebay/callback'
    : callback;

const fake = await FakeEbay.start({
  port: url.port === '' ? 80 : Number(url.port),
  allowHttpPictures: true,
  consentRedirect: { acceptUrl },
  allowHttpNotificationEndpoints: true,
});
handleShutdownSignals({ logger, shutdown: () => fake.close() });
logger.info({ url: fake.url, callbackUrl: acceptUrl }, 'fake eBay ready');
