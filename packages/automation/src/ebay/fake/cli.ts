/**
 * Runs the fake eBay site for local development: `npm run dev:fake-ebay-site`. It listens on
 * 127.0.0.1 at the port of FAKE_EBAY_SITE_URL (see `.env.example`), the site the worker's and
 * the runner's eBay automation adapter then uses instead of ebay.com. Its state lives in memory
 * and is lost when it stops. The fake eBay API (`npm run dev:fake-ebay`) is a different fake.
 */
import { createLogger, handleShutdownSignals } from '@listora/shared';

import { FakeEbaySite } from './fake-ebay-site.ts';

const logger = createLogger({ service: 'fake-ebay-site', level: 'info' });
const url = new URL(process.env['FAKE_EBAY_SITE_URL'] ?? 'http://127.0.0.1:4800');
if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
  logger.error('FAKE_EBAY_SITE_URL must point at 127.0.0.1 or localhost');
  process.exit(1);
}

const site = await FakeEbaySite.start(url.port === '' ? 80 : Number(url.port));
handleShutdownSignals({ logger, shutdown: () => site.close() });
logger.info({ url: site.url }, 'fake eBay site ready');
