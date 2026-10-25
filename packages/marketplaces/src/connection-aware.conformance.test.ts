/**
 * A connection-aware Depop adapter passes the conformance suite in both of its modes: assisted
 * without a connection, and through the API (the fake marketplace) once the connection is `api`.
 */
import { fileURLToPath } from 'node:url';

import { createDepopAssistedAdapter } from './assisted/marketplaces.ts';
import { CONFORMANCE_TIMEOUT_MS, fakeConformanceMarketplace } from './conformance/fake-driver.ts';
import { describeAdapterConformance } from './conformance/suite.ts';
import { ConnectionAwareAdapter } from './connection-aware.ts';
import { FakeMarketplaceAdapter } from './fake/fake-adapter.ts';
import { FakeMarketplace } from './fake/fake-marketplace.ts';

const fake = await FakeMarketplace.start();
const closed = await FakeMarketplace.start();
const unreachableUrl = closed.url;
await closed.close();

const depop = (baseUrl: string): ConnectionAwareAdapter =>
  new ConnectionAwareAdapter({
    assisted: createDepopAssistedAdapter(),
    api: new FakeMarketplaceAdapter({
      marketplace: 'depop',
      baseUrl,
      requestTimeoutMs: CONFORMANCE_TIMEOUT_MS,
    }),
  });

describeAdapterConformance({
  name: 'Depop without a connection',
  adapter: depop(fake.url),
  connection: null,
  goldenDir: fileURLToPath(new URL('assisted/__golden__/depop/', import.meta.url)),
});

describeAdapterConformance({
  name: 'Depop with an api connection',
  adapter: depop(fake.url),
  connection: { id: 'connection-depop', mode: 'api', status: 'connected' },
  goldenDir: fileURLToPath(new URL('__golden__/depop-api/', import.meta.url)),
  marketplace: fakeConformanceMarketplace(fake, 'depop'),
  unreachable: depop(unreachableUrl),
  teardown: () => fake.close(),
});
