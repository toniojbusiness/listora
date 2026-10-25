/**
 * Runs the fake Mercari site for local development: `npm run dev:fake-mercari`. It listens on
 * 127.0.0.1 at the port of FAKE_MERCARI_SITE_URL (see `.env.example`), the site the worker's and
 * the runner's Mercari automation adapter then uses instead of Mercari. Its state lives in
 * memory and is lost when it stops.
 */
import { createLogger, handleShutdownSignals } from '@listora/shared';

import { FakeMercariSite } from './fake-mercari.ts';

const logger = createLogger({ service: 'fake-mercari', level: 'info' });
const url = new URL(process.env['FAKE_MERCARI_SITE_URL'] ?? 'http://127.0.0.1:4600');
if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
  logger.error('FAKE_MERCARI_SITE_URL must point at 127.0.0.1 or localhost');
  process.exit(1);
}

const site = await FakeMercariSite.start(url.port === '' ? 80 : Number(url.port));
handleShutdownSignals({ logger, shutdown: () => site.close() });
logger.info({ url: site.url }, 'fake Mercari site ready');
