import { describe, expect, it } from 'vitest';

import { buyerFirstName, fieldValues, trackingField } from '../adapter/label-fields.ts';
import { orderLabel, readReceipt } from '../depop/pages/receipts.ts';
import { trackingIn } from '../mercari/pages/order-page.ts';

/**
 * A receipt in the shape Depop's receipts API answers (read on a real shop with sales,
 * 2026-10-28), every value invented: one purchase, its items by product id only, and one parcel
 * with its label, deadline, and label expiry.
 */
function depopReceipt(
  purchaseId: number,
  status: string,
  options: {
    productIds?: number[];
    parcelStatus?: string;
    tracking?: string | null;
    parcels?: unknown[];
    /** More of the parcel's fields (the label's file). */
    parcel?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const productIds = options.productIds ?? [purchaseId + 1000];
  return {
    purchase_id: purchaseId,
    transaction_id: purchaseId + 5,
    buyer: { id: 7, username: 'invented_buyer', first_name: 'Robin', country: 'US' },
    seller: { id: 8, username: 'invented_shop', first_name: 'Sam', last_name: 'Seller' },
    status,
    sold_timestamp: '2026-10-27T21:52:10.127364Z',
    is_bundle: productIds.length > 1,
    currency: 'USD',
    items_amount: '40.00',
    buyer_amount: '46.50',
    seller_amount: '34.40',
    has_boosting_fee: true,
    line_items: productIds.map((productId, index) => ({
      id: 900 + index,
      product_id: productId,
      description: `Invented item ${String(index + 1)}\n#invented`,
      picture_url: 'https://media-photos.depop.com/invented/P0.jpg',
    })),
    parcels: options.parcels ?? [
      {
        parcel_id: `parcel-${String(purchaseId)}`,
        shipping_provider: 'USPS',
        parcel_status: options.parcelStatus ?? 'AWAITING_SHIPPING',
        provider_name: 'USPS',
        tracking:
          options.tracking === null
            ? null
            : {
                reference: options.tracking ?? '9400100000000000000001',
                url: 'https://tools.usps.com/invented',
              },
        shipping_deadline: '2026-11-07T21:52:10.127Z',
        label_expires_at: '2026-11-24T21:52:17.000Z',
        purchase_line_items: productIds.map((_id, index) => 900 + index),
        ...options.parcel,
      },
    ],
    shipping_address: { name: 'Invented Person', city: 'Nowhere', state: 'NA' },
  };
}

const labelOf = (receipt: Record<string, unknown>) => readReceipt(receipt).label;

describe('label reads: the pages read by field names only', () => {
  it("reads a Depop receipt's label from its parcel: number, carrier, deadline, expiry, buyer", () => {
    const label = labelOf(depopReceipt(412, 'shipping_pending'));
    expect(label).toEqual({
      purchaseId: '412',
      productIds: [1412],
      state: 'to_ship',
      trackingNumber: '9400100000000000000001',
      carrierName: 'USPS',
      shipBy: new Date('2026-11-07T21:52:10.127Z'),
      labelExpiresAt: new Date('2026-11-24T21:52:17.000Z'),
      labelFileUrl: null,
      buyerFirstName: 'Robin',
    });
    expect(orderLabel({ externalOrderId: '412', externalListingIds: [] }, [label])).toEqual({
      externalOrderId: '412',
      found: true,
      trackingNumber: '9400100000000000000001',
      buyerFirstName: 'Robin',
      orderState: 'to_ship',
      carrierName: 'USPS',
      shipBy: new Date('2026-11-07T21:52:10.127Z'),
      labelExpiresAt: new Date('2026-11-24T21:52:17.000Z'),
      labelFileUrl: null,
    });
    expect(orderLabel({ externalOrderId: '999', externalListingIds: ['x'] }, [label])).toEqual({
      externalOrderId: '999',
      found: false,
    });
  });

  it("takes the label's file only under a field that names it, and only on Depop's own site", () => {
    const fileOf = (parcel: Record<string, unknown>) =>
      labelOf(depopReceipt(412, 'shipping_pending', { parcel })).labelFileUrl;
    const file = 'https://webapi.depop.com/presentation/api/v1/receipts/412/label/';
    expect(fileOf({ label_url: file })).toBe(file);
    expect(fileOf({ shipping_label_url: 'https://www.depop.com/labels/412.pdf' })).toBe(
      'https://www.depop.com/labels/412.pdf',
    );
    expect(fileOf({ label: { url: file } })).toBe(file);
    // A path is on Depop's site.
    expect(fileOf({ label_pdf_url: '/labels/412.pdf' })).toBe(
      'https://www.depop.com/labels/412.pdf',
    );
    // Never the tracking page, a file elsewhere, or plain http.
    expect(fileOf({})).toBeNull();
    expect(fileOf({ label_url: 'https://labels.example.com/412.pdf' })).toBeNull();
    expect(fileOf({ label_url: 'http://www.depop.com/labels/412.pdf' })).toBeNull();
    expect(fileOf({ label_url: 'https://depop.com.example.com/412.pdf' })).toBeNull();
    expect(fileOf({ label_url: '' })).toBeNull();
    // A purchase whose parcels show several labels has no one label to print.
    const several = labelOf(
      depopReceipt(5, 'shipping_pending', {
        parcels: [
          { tracking: { reference: '9400100000000000000001' }, label_url: file },
          { tracking: { reference: '9400100000000000000002' }, label_url: file },
        ],
      }),
    );
    expect(several.labelFileUrl).toBeNull();
  });

  it('decides to ship by the receipt, never the parcel: a refunded order still shows one waiting', () => {
    const states = [
      depopReceipt(1, 'refunded', { parcelStatus: 'AWAITING_SHIPPING' }),
      depopReceipt(2, 'shipped', { parcelStatus: 'IN_TRANSIT' }),
      depopReceipt(3, 'delivered', { parcelStatus: 'IN_TRANSIT' }),
      depopReceipt(4, 'delivered_pending_feedback', { parcelStatus: 'DELIVERED' }),
      depopReceipt(5, 'shipping_pending', { parcelStatus: 'AWAITING_SHIPPING' }),
    ].map((receipt) => labelOf(receipt).state);
    expect(states).toEqual(['canceled', 'shipped', 'shipped', 'shipped', 'to_ship']);
    const refunded = orderLabel({ externalOrderId: '1', externalListingIds: [] }, [
      labelOf(depopReceipt(1, 'refunded')),
    ]);
    expect(refunded).toMatchObject({ found: true, orderState: 'canceled' });
  });

  it('reads a bundle as one package: one label for all its items, found by any of them', () => {
    const bundle = labelOf(
      depopReceipt(77, 'shipping_pending', { productIds: [501, 502, 503, 504] }),
    );
    expect(bundle).toMatchObject({
      productIds: [501, 502, 503, 504],
      trackingNumber: '9400100000000000000001',
    });
    // An order Listora named by its listings, not the purchase: found by the products' slugs.
    const slugOf = new Map([
      [501, 'shop-denim-jacket'],
      [503, 'shop-wool-scarf'],
    ]);
    const byListing = orderLabel(
      { externalOrderId: 'listing:shop-wool-scarf', externalListingIds: ['shop-wool-scarf'] },
      [bundle],
      slugOf,
    );
    expect(byListing).toMatchObject({ found: true, trackingNumber: '9400100000000000000001' });
    expect(
      orderLabel(
        { externalOrderId: 'shop-denim-jacket', externalListingIds: [] },
        [bundle],
        slugOf,
      ),
    ).toMatchObject({ found: true });
    // Without the slugs, a product id is never taken for a listing.
    expect(
      orderLabel({ externalOrderId: 'other', externalListingIds: ['shop-wool-scarf'] }, [bundle]),
    ).toEqual({ externalOrderId: 'other', found: false });
  });

  it('reads no label before Depop has one, nor for a purchase in several parcels', () => {
    expect(labelOf(depopReceipt(9, 'shipping_pending', { tracking: null }))).toMatchObject({
      trackingNumber: null,
      carrierName: null,
      labelExpiresAt: null,
      shipBy: new Date('2026-11-07T21:52:10.127Z'),
    });
    const parcel = (reference: string, deadline: string) => ({
      shipping_provider: 'USPS',
      parcel_status: 'AWAITING_SHIPPING',
      tracking: { reference },
      shipping_deadline: deadline,
      label_expires_at: '2026-11-24T21:52:17.000Z',
    });
    const split = labelOf(
      depopReceipt(10, 'shipping_pending', {
        productIds: [1, 2],
        parcels: [
          parcel('9400100000000000000002', '2026-11-08T00:00:00.000Z'),
          parcel('9400100000000000000003', '2026-11-06T00:00:00.000Z'),
        ],
      }),
    );
    expect(split).toMatchObject({ trackingNumber: null, shipBy: new Date('2026-11-06T00:00:00Z') });
  });

  it('never takes the buyer of a field named otherwise, and refuses a receipt it does not know', () => {
    expect(buyerFirstName({ seller: { first_name: 'Me' } })).toBeNull();
    expect(trackingField({ reference: '9400111899223197428490' })).toBeNull();
    const noBuyer = depopReceipt(11, 'shipping_pending');
    delete noBuyer['buyer'];
    expect(labelOf(noBuyer).buyerFirstName).toBeNull();
    const noParcels = depopReceipt(12, 'shipping_pending');
    delete noParcels['parcels'];
    expect(() => readReceipt(noParcels)).toThrow(/receipts API/);
    expect(fieldValues({ a: [{ b: { slug: 'x' } }] }, ['slug'])).toEqual(['x']);
  });

  it("reads the number on a Mercari order page's Tracking line only", () => {
    expect(trackingIn(['USPS Ground Advantage / 0.50 lb'])).toBeNull();
    expect(trackingIn(['View tracking'])).toBeNull();
    expect(trackingIn(['Tracking number 9400 1118 9922 3197 4284 90'])).toBe(
      '9400111899223197428490',
    );
    expect(trackingIn(['Carrier', 'Tracking #: 1Z999AA10123456784'])).toBe('1Z999AA10123456784');
  });
});
