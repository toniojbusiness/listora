/**
 * Runs the fake Depop for local development: `npm run dev:fake-depop`. It listens on 127.0.0.1
 * at the port of DEPOP_FAKE_URL (see `.env.example`), the URL the worker's Depop adapter uses
 * with `DEPOP_ENV=fake`. Its state lives in memory and is lost when it stops.
 *
 * Local photo storage serves listing photos over http, so this development server accepts http
 * photo URLs; tests use the fake with https only. The development seller's starting refresh
 * token keeps working here, as if the seller consented again each time: Depop rotates refresh
 * tokens, and a restarted worker starts again from the one in configuration.
 */
import { createLogger, handleShutdownSignals } from '@listora/shared';

import { DEFAULT_DEPOP_FAKE_URL } from '../config.ts';
import { FakeDepop } from './fake-depop.ts';

const logger = createLogger({ service: 'fake-depop', level: 'info' });
const configured = process.env['DEPOP_FAKE_URL'];
const url = new URL(
  configured === undefined || configured === '' ? DEFAULT_DEPOP_FAKE_URL : configured,
);
if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
  logger.error('DEPOP_FAKE_URL must point at http://127.0.0.1 or http://localhost');
  process.exit(1);
}

const fake = await FakeDepop.start({
  port: url.port === '' ? 80 : Number(url.port),
  allowHttpPictures: true,
  renewDevelopmentGrant: true,
});
handleShutdownSignals({ logger, shutdown: () => fake.close() });
logger.info({ url: fake.url }, 'fake Depop ready');
