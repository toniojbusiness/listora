/**
 * The assisted marketplaces (docs/features/marketplaces.md). Poshmark, Mercari, and Depop run
 * assisted until the browser runner (decision D1) or Depop's partner API takes over (see
 * ConnectionAwareAdapter), and assisted stays their fallback when automation has to stop. eBay
 * runs assisted only where neither its API nor a linked session serves it, and as the fallback
 * of its automation.
 *
 * Tasks open each marketplace's home page, or the listing's own page once the user has linked
 * it. Deeper links into each app and the marketplaces' own title and description limits are
 * still to be verified (plan red flag RF15), so none is enforced here yet; the marketplace's own
 * form enforces them when the user posts.
 */
import { EBAY_LIMITS } from '../ebay/payload.ts';
import { AssistedAdapter } from './assisted-adapter.ts';

export function createPoshmarkAdapter(): AssistedAdapter {
  return new AssistedAdapter({ marketplace: 'poshmark', siteUrl: 'https://poshmark.com/' });
}

export function createMercariAdapter(): AssistedAdapter {
  return new AssistedAdapter({ marketplace: 'mercari', siteUrl: 'https://www.mercari.com/' });
}

/**
 * Depop before its API is connected. The flags still describe Depop itself, which never reuses
 * an external SKU and has no listing titles, whichever mode serves it.
 */
export function createDepopAssistedAdapter(): AssistedAdapter {
  return new AssistedAdapter({
    marketplace: 'depop',
    siteUrl: 'https://www.depop.com/',
    capabilities: { externalSkuReusable: false, title: 'none' },
  });
}

/**
 * eBay where Listora can't act on it itself: without a connected API and without a linked
 * session (until Listora's eBay developer keys exist), and whenever eBay's browser automation
 * has to stop. eBay marks its own sales sold; titles and photos keep eBay's limits.
 */
export function createEbayAssistedAdapter(): AssistedAdapter {
  return new AssistedAdapter({
    marketplace: 'ebay',
    siteUrl: 'https://www.ebay.com/',
    limits: { titleMaxLength: EBAY_LIMITS.title, maxPhotos: EBAY_LIMITS.photos },
  });
}
