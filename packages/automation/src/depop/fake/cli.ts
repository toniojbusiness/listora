/**
 * Runs the fake Depop site for local development: `npm run dev:fake-depop-site`. It listens on
 * 127.0.0.1 at the port of FAKE_DEPOP_SITE_URL (see `.env.example`), the site the worker's and
 * the runner's Depop automation adapter then uses instead of depop.com. Its state lives in
 * memory and is lost when it stops.
 */
import { createLogger, handleShutdownSignals } from '@listora/shared';

import { FakeDepopSite } from './fake-depop-site.ts';

const logger = createLogger({ service: 'fake-depop-site', level: 'info' });
const url = new URL(process.env['FAKE_DEPOP_SITE_URL'] ?? 'http://127.0.0.1:4700');
if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
  logger.error('FAKE_DEPOP_SITE_URL must point at 127.0.0.1 or localhost');
  process.exit(1);
}

const site = await FakeDepopSite.start(url.port === '' ? 80 : Number(url.port));
handleShutdownSignals({ logger, shutdown: () => site.close() });
logger.info({ url: site.url }, 'fake Depop site ready');
