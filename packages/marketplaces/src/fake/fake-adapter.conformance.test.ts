/**
 * The fake marketplace adapter against the shared conformance suite, once as a marketplace
 * whose reads carry revisions and once as one without a freshness marker.
 */
import { fileURLToPath } from 'node:url';

import { CONFORMANCE_TIMEOUT_MS, fakeConformanceMarketplace } from '../conformance/fake-driver.ts';
import { describeAdapterConformance } from '../conformance/suite.ts';
import { FakeMarketplaceAdapter } from './fake-adapter.ts';
import { FakeMarketplace } from './fake-marketplace.ts';

const fake = await FakeMarketplace.start();
const closed = await FakeMarketplace.start();
const unreachableUrl = closed.url;
await closed.close();

const goldenDir = fileURLToPath(new URL('__golden__/', import.meta.url));

describeAdapterConformance({
  name: 'FakeMarketplaceAdapter with revisions',
  adapter: new FakeMarketplaceAdapter({
    marketplace: 'ebay',
    baseUrl: fake.url,
    requestTimeoutMs: CONFORMANCE_TIMEOUT_MS,
  }),
  connection: null,
  goldenDir,
  marketplace: fakeConformanceMarketplace(fake, 'ebay'),
  unreachable: new FakeMarketplaceAdapter({ marketplace: 'ebay', baseUrl: unreachableUrl }),
});

describeAdapterConformance({
  name: 'FakeMarketplaceAdapter without a freshness marker',
  adapter: new FakeMarketplaceAdapter({
    marketplace: 'depop',
    baseUrl: fake.url,
    requestTimeoutMs: CONFORMANCE_TIMEOUT_MS,
    readFreshness: 'none',
  }),
  connection: { id: 'connection-depop', mode: 'api' },
  goldenDir: fileURLToPath(new URL('__golden__/no-freshness/', import.meta.url)),
  marketplace: fakeConformanceMarketplace(fake, 'depop'),
  unreachable: new FakeMarketplaceAdapter({ marketplace: 'depop', baseUrl: unreachableUrl }),
  teardown: () => fake.close(),
});
