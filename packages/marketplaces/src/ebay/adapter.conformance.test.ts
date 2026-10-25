/**
 * The eBay adapter against the shared conformance suite, through the fake eBay (Trading XML,
 * Media, Fulfillment, OAuth), under an api connection.
 */
import { fileURLToPath } from 'node:url';

import { CONFORMANCE_TIMEOUT_MS } from '../conformance/fake-driver.ts';
import { describeAdapterConformance } from '../conformance/suite.ts';
import { loadEbayConfig } from './config.ts';
import { createEbayAdapter } from './create.ts';
import { fakeEbayConformanceMarketplace } from './fake/conformance-driver.ts';
import { FakeEbay } from './fake/fake-ebay.ts';

const fake = await FakeEbay.start();
const closed = await FakeEbay.start();
const unreachableUrl = closed.url;
await closed.close();

/** The suite's connection, which the configured seller is bound to. */
const CONNECTION_ID = 'connection-ebay';

function adapterAt(url: string) {
  const config = loadEbayConfig({
    EBAY_ENV: 'fake',
    EBAY_FAKE_URL: url,
    EBAY_USER_CONNECTION_ID: CONNECTION_ID,
  });
  if (config === undefined) throw new Error('EBAY_ENV=fake gives a configuration');
  return createEbayAdapter(config, { requestTimeoutMs: CONFORMANCE_TIMEOUT_MS });
}

describeAdapterConformance({
  name: 'EbayAdapter',
  adapter: adapterAt(fake.url),
  connection: { id: CONNECTION_ID, mode: 'api', status: 'connected' },
  goldenDir: fileURLToPath(new URL('__golden__/', import.meta.url)),
  marketplace: fakeEbayConformanceMarketplace(fake, { lateAnswerMs: 5 * CONFORMANCE_TIMEOUT_MS }),
  unreachable: adapterAt(unreachableUrl),
  teardown: () => fake.close(),
});
