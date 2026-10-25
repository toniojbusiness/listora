/**
 * The browser runner (decision D1): the on-demand process that runs automated marketplace
 * steps and sale checks in headless Chromium, one seller session at a time. The worker starts
 * it when automated work waits (a child process locally, the ECS service in AWS), and it exits
 * once it has had nothing to do for `RUNNER_IDLE_EXIT_SECONDS`, scaling its ECS service back to
 * zero. `self-test` launches the browser once and exits (the image smoke test).
 */
import { ECSClient } from '@aws-sdk/client-ecs';

import {
  createAutomationAdapters,
  HttpPhotoSource,
  isAutomatedMarketplace,
  isSaleCheckJobPayload,
  loadChromium,
  openRunnerPresence,
  PlaywrightBrowserRunner,
  RunnerSessions,
  runnerWorkPending,
  runSaleCheck,
  SALE_CHECK_TASK,
  scaleRunnerServiceToZero,
  StorageScreenshotStore,
} from '@listora/automation';
import { createDatabase } from '@listora/db';
import { startOperationWorker } from '@listora/operations';
import { createLogger, handleShutdownSignals } from '@listora/shared';
import { createStorage } from '@listora/storage';
import { createTokenCipher, SessionVault } from '@listora/vault';

import { createAdapters } from '../adapters.ts';
import { loadRunnerConfig } from './config.ts';

if (process.argv[2] === 'self-test') {
  const logger = createLogger({ service: 'runner', level: 'info' });
  try {
    const chromium = await loadChromium();
    const browser = await chromium.launch({ headless: true, timeout: 30_000 });
    const page = await browser.newPage();
    await page.goto('data:text/html,<title>runner self-test</title>');
    const title = await page.title();
    await browser.close();
    if (title !== 'runner self-test') throw new Error(`the page title was ${title}`);
    logger.info({ version: browser.version() }, 'browser self-test passed');
  } catch (error) {
    logger.fatal({ err: error }, 'browser self-test failed');
    process.exitCode = 1;
  }
} else {
  await run();
}

async function run(): Promise<void> {
  const config = loadRunnerConfig();
  const logger = createLogger({ service: 'runner', level: config.logLevel });
  const settings = config.automation;
  const db = createDatabase({ connectionString: config.databaseUrl, max: 8 });
  const browser = new PlaywrightBrowserRunner({
    logger,
    screenshots: new StorageScreenshotStore(createStorage(config.storage)),
    stepTimeoutMs: settings.stepTimeoutMs,
  });
  const fatal = (error: Error): void => {
    logger.fatal({ err: error }, 'runner cannot continue safely; exiting');
    process.exit(1);
  };

  try {
    // While this session is open, workers know a runner is alive and start no other.
    const presence = await openRunnerPresence(config.databaseUrl, fatal);
    const sessions = new RunnerSessions({
      db,
      vault: new SessionVault({ cipher: createTokenCipher(config.tokenCipher), logger }),
      runner: browser,
      profile: (marketplace) =>
        isAutomatedMarketplace(marketplace) ? settings.profiles[marketplace] : undefined,
      logger,
    });
    const automation = createAutomationAdapters({
      settings,
      sessions,
      photos: new HttpPhotoSource(),
      logger,
    });
    // The runner never runs eBay steps (they are never automated), so it builds no eBay adapter.
    const adapters = createAdapters({ ...config, ebay: undefined }, automation);
    const worker = await startOperationWorker({
      role: 'automation',
      connectionString: config.databaseUrl,
      db,
      adapters: adapters.lookup,
      logger,
      callTimeoutMs: settings.callTimeoutMs,
      tasks: {
        [SALE_CHECK_TASK]: async (payload, signal) => {
          if (!isSaleCheckJobPayload(payload)) {
            logger.error({ task: SALE_CHECK_TASK }, 'job with an invalid payload; dropping it');
            return;
          }
          await runSaleCheck(
            { db, adapters: adapters.lookup, settings: settings.saleChecks, logger },
            payload,
            signal,
          );
        },
      },
      onFatalError: fatal,
    });

    let stopping = false;
    const stop = async (reason: 'idle' | 'signal'): Promise<void> => {
      if (stopping) return;
      stopping = true;
      clearInterval(idleCheck);
      logger.info({ reason }, 'browser runner stopping');
      await worker.stop();
      await browser.close();
      // Idle in AWS: nothing is left to do, so the service goes back to no task.
      if (reason === 'idle' && config.launch.kind === 'ecs') {
        await scaleRunnerServiceToZero(
          config.launch,
          new ECSClient({ region: config.launch.region }),
        ).catch((error: unknown) => {
          logger.error({ err: error }, 'could not scale the browser runner service to zero');
        });
      }
      await presence.close();
      await db.destroy();
    };

    let lastBusy = Date.now();
    const idleCheck = setInterval(
      () => {
        void (async () => {
          if (config.idleExitMs === 0 || stopping) return;
          if (await runnerWorkPending(db)) {
            lastBusy = Date.now();
          } else if (Date.now() - lastBusy >= config.idleExitMs) {
            await stop('idle');
            logger.info('shutdown complete');
            process.exit(0);
          }
        })().catch((error: unknown) => {
          logger.error({ err: error }, 'idle check failed');
        });
      },
      Math.min(5_000, Math.max(250, config.idleExitMs / 4)),
    );

    // Within the 30 seconds ECS waits before it kills the task; a step cut short is read back.
    handleShutdownSignals({ logger, shutdown: () => stop('signal'), timeoutMs: 25_000 });
    logger.info(
      {
        poolId: worker.poolId,
        automated: Object.keys(automation),
        idleExitMs: config.idleExitMs,
      },
      'runner ready',
    );
  } catch (error) {
    logger.fatal({ err: error }, 'runner failed to start');
    await browser.close();
    await db.destroy();
    process.exitCode = 1;
  }
}
