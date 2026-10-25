/**
 * Runs the fake Poshmark for local development: `npm run dev:fake-poshmark`. It listens on
 * 127.0.0.1 at the port of FAKE_POSHMARK_URL (see `.env.example`), which the worker's and the
 * runner's Poshmark automation adapter then drives instead of poshmark.com. Its state lives in
 * memory and is lost when it stops; it rotates session cookies every 20 pages, like Poshmark.
 */
import { createLogger, handleShutdownSignals } from '@listora/shared';

import { FakePoshmark } from './fake-poshmark.ts';

const logger = createLogger({ service: 'fake-poshmark', level: 'info' });
const url = new URL(process.env['FAKE_POSHMARK_URL'] ?? 'http://127.0.0.1:4500');
if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
  logger.error('FAKE_POSHMARK_URL must point at 127.0.0.1 or localhost');
  process.exit(1);
}

const site = await FakePoshmark.start(url.port === '' ? 80 : Number(url.port), {
  rotateSessionEvery: 20,
});
handleShutdownSignals({ logger, shutdown: () => site.close() });
logger.info({ url: site.url }, 'fake Poshmark ready');
