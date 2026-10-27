import { describe, expect, it } from 'vitest';

import { buyerFirstName, fieldValues, trackingField } from '../adapter/label-fields.ts';
import { orderLabel, receiptLabel } from '../depop/pages/receipts.ts';
import { trackingIn } from '../mercari/pages/order-page.ts';

describe('label reads: the pages read by field names only', () => {
  it("reads a Depop receipt's label and buyer's first name, and matches it by id or product", () => {
    const receipt = receiptLabel({
      id: 412,
      buyer: { first_name: 'Sarah', last_name: 'M' },
      products: [{ slug: 'shop-black-tee-1' }],
      shipment: { tracking_number: '9400111899223197428490' },
    });
    expect(receipt).toEqual({
      ids: ['412'],
      slugs: ['shop-black-tee-1'],
      trackingNumber: '9400111899223197428490',
      buyerFirstName: 'Sarah',
    });
    expect(orderLabel({ externalOrderId: '412', externalListingIds: [] }, [receipt])).toMatchObject({
      found: true,
      trackingNumber: '9400111899223197428490',
    });
    expect(
      orderLabel({ externalOrderId: 'shop-black-tee-1', externalListingIds: [] }, [receipt]),
    ).toMatchObject({ found: true });
    expect(orderLabel({ externalOrderId: 'other', externalListingIds: ['x'] }, [receipt])).toEqual({
      externalOrderId: 'other',
      found: false,
    });
  });

  it('never takes the buyer of a field named otherwise, and refuses a receipt naming nothing', () => {
    expect(buyerFirstName({ seller: { first_name: 'Me' } })).toBeNull();
    expect(trackingField({ reference: '9400111899223197428490' })).toBeNull();
    expect(() => receiptLabel({ total: '12.00' })).toThrow(/without an id or a product/);
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
