/**
 * Test-only helpers (not exported from the package): the synthetic fixtures in `fixtures/`, as
 * the receiving server hands them over, with the forwarding address it delivered to and its
 * SPF and DKIM verdicts.
 */
import { readFileSync } from 'node:fs';

import { DEV_RECEIVER } from './drivers/folder.ts';

const FIXTURES = new URL('../fixtures/', import.meta.url);

export type FixtureName =
  | 'poshmark-sold'
  | 'mercari-sold'
  | 'depop-sold'
  | 'poshmark-sold-no-link'
  | 'mercari-sold-sku'
  | 'poshmark-offer'
  | 'depop-sold-new-format'
  | 'gmail-forwarding';

export function fixture(name: FixtureName, token = 'aaaaaaaaaaaaaaaaaaaa'): string {
  return readFileSync(new URL(`${name}.eml`, FIXTURES), 'utf8').replaceAll('{{token}}', token);
}

export interface Delivery {
  /** The forwarding address it was delivered to. */
  to: string;
  /** SPF's verdict; `pass` unless a test says otherwise. */
  spf?: string;
  /** The domain whose DKIM signature passed, or null for none. */
  dkim: string | null;
  /** The receiver named in `Authentication-Results`; the folder driver trusts `mx.listora.test`. */
  receiver?: string;
  /** Extra headers before the message's own, as an attacker might add (`Name: value`). */
  forgedHeaders?: readonly string[];
  /** Changes to the message itself (a new Message-ID, a different From). */
  edit?: (message: string) => string;
}

/** The message with the receiving server's headers on top, as a dropped `.eml` file holds it. */
export function deliver(message: string, delivery: Delivery): Uint8Array {
  const dkim = delivery.dkim === null ? 'dkim=none' : `dkim=pass header.d=${delivery.dkim}`;
  const headers = [
    `Delivered-To: ${delivery.to}`,
    `Authentication-Results: ${delivery.receiver ?? DEV_RECEIVER}; spf=${delivery.spf ?? 'pass'} smtp.mailfrom=forwarder.example; ${dkim}`,
  ];
  const body = delivery.edit === undefined ? message : delivery.edit(message);
  const crlf = [...headers, ...(delivery.forgedHeaders ?? []), body]
    .join('\n')
    .replace(/\r?\n/g, '\r\n');
  return new TextEncoder().encode(crlf);
}
