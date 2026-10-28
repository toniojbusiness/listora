import { describe, expect, it } from 'vitest';

import { canonicalTracking, carrierOf, scanMatchesTracking, trackingTail } from './tracking.ts';
import { SCANNED_LABELS } from './test-fixtures.ts';

describe('canonicalTracking', () => {
  it.each(SCANNED_LABELS)('reads $name', ({ scanned, tracking }) => {
    expect(canonicalTracking(scanned)).toBe(tracking);
  });

  it('refuses codes that cannot be a tracking number', () => {
    expect(canonicalTracking('')).toBeNull();
    expect(canonicalTracking('12345')).toBeNull();
    expect(canonicalTracking('ABCDEFGHIJKLMN')).toBeNull();
    expect(canonicalTracking('9'.repeat(41))).toBeNull();
  });
});

describe('scanMatchesTracking', () => {
  it('matches the same number and a longer barcode that ends with it', () => {
    expect(scanMatchesTracking('9400111899223197428490', '9400111899223197428490')).toBe(true);
    expect(scanMatchesTracking('9622001900005105596800449781779931', '449781779931')).toBe(true);
  });

  it('never matches another number or a short one', () => {
    expect(scanMatchesTracking('9400111899223197428490', '9400111899223197428491')).toBe(false);
    expect(scanMatchesTracking('9400111899223197428490', '28490')).toBe(false);
  });
});

describe('carrierOf', () => {
  it('names the carrier from the number', () => {
    expect(carrierOf('9400111899223197428490')).toBe('usps');
    expect(carrierOf('1Z999AA10123456784')).toBe('ups');
    expect(carrierOf('449781779931')).toBe('fedex');
    expect(carrierOf('ABC1234567890X')).toBe('other');
  });

  it('shows the tail only', () => {
    expect(trackingTail('9400111899223197428490')).toBe('•••• 8490');
  });
});
