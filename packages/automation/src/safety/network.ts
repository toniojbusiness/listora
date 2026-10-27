/**
 * Where an automated browser may send requests. A session drives one marketplace, so its main
 * frame only ever loads that marketplace's own origins, and no request may reach a private
 * address (loopback, the private ranges, link-local, which holds the cloud's metadata and task
 * credential endpoints, and internal host names). Pages still load their images, scripts, and
 * styles from other public hosts (the marketplaces' CDNs).
 *
 * The browser runner checks every request against these rules before it is sent
 * (browser-runner.ts). Chromium follows HTTP redirects without asking, so a redirect hop is not
 * checked; a main frame that ends up elsewhere is caught by the page inspection
 * (challenges.ts), which stops the run, and its page is never kept in a screenshot.
 */
import { BlockList, isIP } from 'node:net';

import type { AutomationProfile } from '../profiles.ts';

const PRIVATE_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}

/** Host names that name this machine or a private network rather than a public site. */
const PRIVATE_NAMES = /(^|\.)(localhost|internal|local|localdomain|home\.arpa)\.?$/i;

/** Whether `hostname` (as `URL.hostname` gives it) is a private address or an internal name. */
export function isPrivateHost(hostname: string): boolean {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  switch (isIP(host)) {
    case 4:
      return PRIVATE_ADDRESSES.check(host, 'ipv4');
    case 6: {
      const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host)?.[1];
      if (mapped !== undefined) return PRIVATE_ADDRESSES.check(mapped, 'ipv4');
      // `::ffff:a.b.c.d` as URL serializes it, in hex.
      const hex = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i.exec(host);
      if (hex?.[1] !== undefined && hex[2] !== undefined) {
        const value = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
        const v4 = [24, 16, 8, 0].map((shift) => String((value >>> shift) & 0xff)).join('.');
        return PRIVATE_ADDRESSES.check(v4, 'ipv4');
      }
      return PRIVATE_ADDRESSES.check(host, 'ipv6');
    }
    default:
      return host === '' || PRIVATE_NAMES.test(host);
  }
}

/**
 * Whether the browser may send a request to `url`. `mainFrameNavigation` is a navigation of a
 * page's main frame (a link, a form, a script setting `location`). The profile's own origins
 * are always allowed (in development they are the local fake site's), and so are its web API's
 * origins for anything but a main-frame navigation.
 */
export function requestAllowed(
  url: string,
  mainFrameNavigation: boolean,
  profile: Pick<AutomationProfile, 'origins'> & Partial<Pick<AutomationProfile, 'apiOrigins'>>,
): boolean {
  if (!URL.canParse(url)) return false;
  const target = new URL(url);
  if (target.protocol === 'data:' || target.protocol === 'blob:') return !mainFrameNavigation;
  const origin =
    target.protocol === 'wss:' || target.protocol === 'ws:'
      ? `${target.protocol === 'wss:' ? 'https:' : 'http:'}//${target.host}`
      : target.origin;
  if (profile.origins.includes(origin)) return true;
  if (mainFrameNavigation) return false;
  if (profile.apiOrigins?.includes(origin) === true) return true;
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(target.protocol)) return false;
  return !isPrivateHost(target.hostname);
}
