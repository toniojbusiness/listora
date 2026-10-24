/**
 * Runs the fake marketplace for local development: `npm run dev:fake-marketplace`. It listens
 * on 127.0.0.1 at the port of FAKE_MARKETPLACE_URL (see `.env.example`), the URL the worker's
 * adapters then use. Its state lives in memory and is lost when it stops.
 */
import { createLogger, handleShutdownSignals } from '@listora/shared';

import { FakeMarketplace } from './fake-marketplace.ts';

const logger = createLogger({ service: 'fake-marketplace', level: 'info' });
const url = new URL(process.env['FAKE_MARKETPLACE_URL'] ?? 'http://127.0.0.1:4100');
if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
  logger.error('FAKE_MARKETPLACE_URL must point at 127.0.0.1 or localhost');
  process.exit(1);
}

const fake = await FakeMarketplace.start(url.port === '' ? 80 : Number(url.port));
handleShutdownSignals({ logger, shutdown: () => fake.close() });
logger.info({ url: fake.url }, 'fake marketplace ready');
