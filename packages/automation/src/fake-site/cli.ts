/**
 * Runs the fake marketplace site for local development: `npm run dev:fake-site`. It listens on
 * 127.0.0.1 at the port of FAKE_AUTOMATION_SITE_URL (see `.env.example`), the site the worker's
 * and the runner's automation adapters then use. Its state lives in memory and is lost when it
 * stops; it rotates session cookies every 20 pages, like a marketplace that refreshes them.
 */
import { createLogger, handleShutdownSignals } from '@listora/shared';

import { FakeAutomationSite } from './fake-site.ts';

const logger = createLogger({ service: 'fake-site', level: 'info' });
const url = new URL(process.env['FAKE_AUTOMATION_SITE_URL'] ?? 'http://127.0.0.1:4300');
if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
  logger.error('FAKE_AUTOMATION_SITE_URL must point at 127.0.0.1 or localhost');
  process.exit(1);
}

const site = await FakeAutomationSite.start(url.port === '' ? 80 : Number(url.port), {
  rotateSessionEvery: 20,
});
handleShutdownSignals({ logger, shutdown: () => site.close() });
logger.info({ url: site.url }, 'fake marketplace site ready');
