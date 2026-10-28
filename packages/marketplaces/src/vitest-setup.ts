/**
 * Every test file (vitest.config.ts `setupFiles`) runs on the fake marketplaces with every
 * feature Listora built, as the local stacks do (MARKETPLACE_FEATURES=all): a feature's own tests
 * test it whether or not it passed live yet. The tests of the gate itself
 * (docs/features/verified-features.md) switch to the verified features and back.
 */
import { useMarketplaceFeatures } from './features.ts';

useMarketplaceFeatures('all');
