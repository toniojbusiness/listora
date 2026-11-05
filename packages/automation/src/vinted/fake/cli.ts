/**
 * Runs the fake Vinted site for local development: `npm run dev:fake-vinted-site`. It listens on
 * 127.0.0.1 at the port of FAKE_VINTED_SITE_URL (see `.env.example`), the site the worker's and
 * the runner's Vinted automation adapter then uses instead of Vinted. Its state lives in memory
 * and is lost when it stops.
 */
import { createLogger, handleShutdownSignals } from '@listora/shared';

import { FakeVintedSite } from './fake-vinted-site.ts';

const logger = createLogger({ service: 'fake-vinted', level: 'info' });
const url = new URL(process.env['FAKE_VINTED_SITE_URL'] ?? 'http://127.0.0.1:4800');
if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
  logger.error('FAKE_VINTED_SITE_URL must point at 127.0.0.1 or localhost');
  process.exit(1);
}

const site = await FakeVintedSite.start(url.port === '' ? 80 : Number(url.port));
handleShutdownSignals({ logger, shutdown: () => site.close() });
logger.info({ url: site.url }, 'fake Vinted site ready');
