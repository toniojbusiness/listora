/** The assisted marketplaces against the shared conformance suite. */
import { fileURLToPath } from 'node:url';

import { describeAdapterConformance } from '../conformance/suite.ts';
import {
  createDepopAssistedAdapter,
  createEbayAssistedAdapter,
  createMercariAdapter,
  createPoshmarkAdapter,
} from './marketplaces.ts';

const golden = (name: string): string =>
  fileURLToPath(new URL(`__golden__/${name}/`, import.meta.url));

describeAdapterConformance({
  name: 'Poshmark (assisted)',
  adapter: createPoshmarkAdapter(),
  connection: null,
  goldenDir: golden('poshmark'),
});

describeAdapterConformance({
  name: 'Mercari (assisted)',
  adapter: createMercariAdapter(),
  connection: null,
  goldenDir: golden('mercari'),
});

describeAdapterConformance({
  name: 'Depop (assisted)',
  adapter: createDepopAssistedAdapter(),
  connection: { id: 'connection-depop', mode: 'assisted', status: 'connected' },
  goldenDir: golden('depop'),
});

describeAdapterConformance({
  name: 'eBay (assisted)',
  adapter: createEbayAssistedAdapter(),
  connection: null,
  goldenDir: golden('ebay'),
});
