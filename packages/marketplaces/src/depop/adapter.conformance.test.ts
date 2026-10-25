/**
 * The Depop adapter against the shared conformance suite, through the fake Depop (the Selling
 * API and OAuth, every request and response checked against Depop's openapi.yaml), under an api
 * connection.
 */
import { fileURLToPath } from 'node:url';

import { afterAll, expect, it } from 'vitest';

import { CONFORMANCE_TIMEOUT_MS } from '../conformance/fake-driver.ts';
import { describeAdapterConformance } from '../conformance/suite.ts';
import { loadDepopConfig } from './config.ts';
import { createDepopAdapter } from './create.ts';
import { fakeDepopConformanceMarketplace } from './fake/conformance-driver.ts';
import { FakeDepop } from './fake/fake-depop.ts';

const fake = await FakeDepop.start();
const closed = await FakeDepop.start();
const unreachableUrl = closed.url;
await closed.close();

/** The suite's connection, which the configured seller is bound to. */
const CONNECTION_ID = 'connection-depop';

function adapterAt(url: string) {
  const config = loadDepopConfig({
    DEPOP_ENV: 'fake',
    DEPOP_FAKE_URL: url,
    DEPOP_USER_CONNECTION_ID: CONNECTION_ID,
  });
  if (config === undefined) throw new Error('DEPOP_ENV=fake gives a configuration');
  return createDepopAdapter(config, {
    requestTimeoutMs: CONFORMANCE_TIMEOUT_MS,
    refusalGraceMs: 30,
  });
}

describeAdapterConformance({
  name: 'DepopAdapter',
  adapter: adapterAt(fake.url),
  connection: { id: CONNECTION_ID, mode: 'api' },
  goldenDir: fileURLToPath(new URL('__golden__/', import.meta.url)),
  // An item in a category whose Depop product type Depop's documentation names.
  content: { item: { category: 'clothing/tops/t_shirts' } },
  marketplace: fakeDepopConformanceMarketplace(fake, { lateAnswerMs: 5 * CONFORMANCE_TIMEOUT_MS }),
  unreachable: adapterAt(unreachableUrl),
  teardown: () => fake.close(),
});

afterAll(() => {
  // Neither the adapter nor the fake ever broke Depop's published contract.
  expect(fake.specViolations).toEqual([]);
});

it('runs the suite against the fake Depop', () => {
  expect(fake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});
