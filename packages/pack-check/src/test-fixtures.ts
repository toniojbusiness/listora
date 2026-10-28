/**
 * Scanned shipping labels, as a phone camera reads their barcodes (made-up numbers in the
 * carriers' real layouts), for the unit tests here, the API's tests, and the iPhone app's tests
 * (apps/ios's `PackCheckFeatureTests` and UI tests use the same strings).
 */
export const SCANNED_LABELS = [
  {
    name: 'a USPS IMpb barcode with its symbology identifier and FNC1 separator',
    scanned: ']C142094107\u001d9400111899223197428490',
    tracking: '9400111899223197428490',
  },
  {
    name: 'a USPS IMpb barcode read as one run of digits',
    scanned: '420941079400111899223197428490',
    tracking: '9400111899223197428490',
  },
  {
    name: 'a USPS IMpb barcode with ZIP+4',
    scanned: '420941071234\u001d9400111899223197428490',
    tracking: '9400111899223197428490',
  },
  {
    name: 'a USPS number typed with spaces',
    scanned: '9400 1118 9922 3197 4284 90',
    tracking: '9400111899223197428490',
  },
  { name: 'a UPS 1Z number', scanned: '1Z999AA10123456784', tracking: '1Z999AA10123456784' },
  {
    name: 'a FedEx barcode, which ends with the 12-digit number',
    scanned: '9622001900005105596800449781779931',
    tracking: '9622001900005105596800449781779931',
  },
] as const;

/** The double print: one label printed twice, and the other order's label. */
export const DOUBLE_PRINT = {
  /** Order A's label: printed twice. */
  labelA: ']C142094107\u001d9400111899223197428490',
  /** The second copy of order A's label, read the plain way. */
  labelACopy: '420941079400111899223197428490',
  /** Order B's label. */
  labelB: '420900129400111899223197420001',
  trackingA: '9400111899223197428490',
  trackingB: '9400111899223197420001',
} as const;
