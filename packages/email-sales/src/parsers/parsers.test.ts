/**
 * The sold-email parsers against the synthetic fixtures (fixtures/README.md): each
 * marketplace's sold notice reads as a sale with its listing id, title, price, and order
 * number; a notice that is no sale is ignored; a sold notice in an unknown format says so.
 */
import { describe, expect, it } from 'vitest';

import { readMessage } from '../message.ts';
import { fixture, type FixtureName } from '../test-support.ts';
import type { EmailSaleMarketplace } from '../senders.ts';
import { parseSaleEmail } from './index.ts';

async function parse(marketplace: EmailSaleMarketplace, name: FixtureName) {
  return parseSaleEmail(marketplace, await readMessage(new TextEncoder().encode(fixture(name))));
}

describe('sold email parsers', () => {
  it('reads Poshmark’s sold notice', async () => {
    expect(await parse('poshmark', 'poshmark-sold')).toEqual({
      type: 'sale',
      sale: {
        orderNumber: '6731f0a1c2b3d4e5f6a7b8c9',
        externalListingId: '65f1c2a3b4d5e6f7a8b9c0d1',
        sku: null,
        title: "Levi's Vintage Trucker Jacket Size M",
        priceCents: 4500,
      },
    });
  });

  it('reads Mercari’s sold notice', async () => {
    expect(await parse('mercari', 'mercari-sold')).toEqual({
      type: 'sale',
      sale: {
        orderNumber: '102938475',
        externalListingId: 'm48213907561',
        sku: null,
        title: "Nike Air Max 90 Men's Size 10",
        priceCents: 3000,
      },
    });
  });

  it('reads Depop’s sold notice (HTML only)', async () => {
    expect(await parse('depop', 'depop-sold')).toEqual({
      type: 'sale',
      sale: {
        orderNumber: '88112233',
        externalListingId: 'janescloset-y2k-baby-tee-butterfly',
        sku: null,
        title: 'Y2K Baby Tee Butterfly Print',
        priceCents: 2500,
      },
    });
  });

  it('reads a notice without a listing link by its title', async () => {
    const parsed = await parse('poshmark', 'poshmark-sold-no-link');
    expect(parsed).toMatchObject({
      type: 'sale',
      sale: {
        externalListingId: null,
        title: 'Patagonia Better Sweater Fleece Jacket',
        priceCents: 6200,
      },
    });
  });

  it('finds Listora’s SKU in the text', async () => {
    const parsed = await parse('mercari', 'mercari-sold-sku');
    expect(parsed).toMatchObject({ type: 'sale', sale: { sku: 'JD-000042', priceCents: 5450 } });
  });

  it('ignores a marketplace email that is no sale', async () => {
    expect(await parse('poshmark', 'poshmark-offer')).toEqual({ type: 'not_a_sale' });
  });

  it('reports a sold notice it cannot read as an unknown format', async () => {
    expect(await parse('depop', 'depop-sold-new-format')).toEqual({
      type: 'unknown_format',
      reason: 'It shows no price Listora can read.',
    });
  });

  it('never reads another marketplace’s listing link as its own', async () => {
    const message = await readMessage(
      new TextEncoder().encode(
        fixture('mercari-sold').replace(
          'https://www.mercari.com/us/item/m48213907561/',
          'https://poshmark.com/listing/Other-65f1c2a3b4d5e6f7a8b9c0d1',
        ),
      ),
    );
    expect(parseSaleEmail('mercari', message)).toMatchObject({
      type: 'sale',
      sale: { externalListingId: null },
    });
  });
});
