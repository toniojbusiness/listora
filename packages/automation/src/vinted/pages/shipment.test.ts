import { describe, expect, it } from 'vitest';

import { addBusinessDays, orderLabel } from './shipment.ts';

const site = { origin: 'https://www.vinted.com' };
const request = { externalOrderId: '71', externalListingIds: [], soldAt: '2026-11-07T10:00:00Z' };
const read = (transaction: Record<string, unknown>) =>
  orderLabel(request, { id: '71', ...transaction }, site);

describe("Vinted's shipment, for Pack check", () => {
  it('counts 5 business days, weekends left out', () => {
    // Saturday, then Friday and Monday.
    expect(addBusinessDays(new Date('2026-11-07T10:00:00Z'), 5)).toEqual(
      new Date('2026-11-13T10:00:00Z'),
    );
    expect(addBusinessDays(new Date('2026-11-06T10:00:00Z'), 5)).toEqual(
      new Date('2026-11-13T10:00:00Z'),
    );
    expect(addBusinessDays(new Date('2026-11-09T10:00:00Z'), 5)).toEqual(
      new Date('2026-11-16T10:00:00Z'),
    );
  });

  it('takes the date Vinted shows over the rule (an extension moves it), and no date without either', () => {
    expect(read({ shipment: { ship_by: '2026-11-20T10:00:00Z' } })).toMatchObject({
      shipBy: new Date('2026-11-20T10:00:00Z'),
    });
    expect(
      orderLabel({ externalOrderId: '71', externalListingIds: [] }, { id: '71' }, site),
    ).toMatchObject({
      shipBy: null,
    });
  });

  it('reads the order state only from statuses it knows, never a guess', () => {
    expect(read({ status: 'in_progress' })).toMatchObject({ orderState: 'to_ship' });
    expect(read({ status: 'in_progress', shipment: { status: 'in_transit' } })).toMatchObject({
      orderState: 'shipped',
    });
    expect(read({ status: 'completed' })).toMatchObject({ orderState: 'shipped' });
    expect(read({ status: 'in_progress', shipment: { status: 'Cancelled' } })).toMatchObject({
      orderState: 'canceled',
    });
    expect(read({ status: 'something new' })).not.toHaveProperty('orderState');
  });

  it('reads the carrier and format in any of the shapes it knows, and no buyer name', () => {
    expect(
      read({
        shipment: { courier: { title: 'SpeedX' }, label_format: 'QR code', tracking_code: 123 },
      }),
    ).toMatchObject({
      carrierName: 'SpeedX',
      labelFormat: 'qr_code',
      trackingNumber: '123',
      buyerFirstName: null,
    });
    expect(read({ shipment: { label_type: 'mystery' } })).toMatchObject({
      labelFormat: null,
      trackingNumber: null,
      carrierName: null,
    });
  });

  it("takes a label file only on Vinted's site, and none for a QR code", () => {
    expect(read({ shipment: { label_url: '/shipments/1/label.pdf' } })).toMatchObject({
      labelFileUrl: 'https://www.vinted.com/shipments/1/label.pdf',
    });
    expect(read({ shipment: { label_url: 'https://evil.example/vinted.com.pdf' } })).toMatchObject({
      labelFileUrl: null,
    });
    expect(
      read({ shipment: { label_url: '/shipments/1/qr.png', label_type: 'qr_code' } }),
    ).toMatchObject({ labelFileUrl: null });
  });
});
