import { describe, expect, it } from 'vitest';

import { shippingNote } from './shipping-note.ts';

describe('shippingNote', () => {
  it('tells a Vinted seller the 5 business days and the extra days they can ask for, as information', () => {
    const note = shippingNote('vinted', { carrier: 'usps', format: 'label' });
    expect(note).toBe(
      "Vinted cancels the order if it isn't shipped within 5 business days. Need more time? Ask the buyer in Vinted for 3 or 5 more days.",
    );
    expect(shippingNote('vinted', null)).toBe(note);
  });

  it('says a QR code is shown at the carrier the buyer picked, with nothing to print', () => {
    expect(shippingNote('vinted', { carrier: 'speedx', format: 'qr_code' })).toMatch(
      /^No label to print: show the QR code in Vinted at the SpeedX counter, which prints the label\. Vinted cancels/,
    );
    expect(shippingNote('vinted', { carrier: 'other', format: 'qr_code' })).toContain(
      "at the carrier's counter",
    );
  });

  it('says nothing for the other marketplaces', () => {
    for (const marketplace of ['depop', 'poshmark', 'mercari', 'ebay'] as const) {
      expect(shippingNote(marketplace, { carrier: 'usps', format: null })).toBeNull();
    }
  });

  it('fits the contract', () => {
    expect(shippingNote('vinted', { carrier: 'fedex', format: 'qr_code' })?.length).toBeLessThan(
      300,
    );
  });
});
