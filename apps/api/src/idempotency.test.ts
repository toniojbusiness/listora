import { describe, expect, it } from 'vitest';

import { hashRequest } from './idempotency.ts';

describe('hashRequest', () => {
  const base = { key: 'k', operationId: 'createItem' };

  it('ignores key order and absent values', () => {
    expect(
      hashRequest({
        ...base,
        request: { params: {}, body: { details: { a: 1, b: [1, { c: 2, d: undefined }] } } },
      }),
    ).toBe(
      hashRequest({
        ...base,
        request: { body: { details: { b: [1, { c: 2 }], a: 1 } }, params: {} },
      }),
    );
  });

  it('differs for a different operation, body, or path', () => {
    const hash = hashRequest({ ...base, request: { params: { itemId: '1' }, body: { a: 1 } } });
    expect(
      hashRequest({
        ...base,
        operationId: 'addItemPhoto',
        request: { params: { itemId: '1' }, body: { a: 1 } },
      }),
    ).not.toBe(hash);
    expect(hashRequest({ ...base, request: { params: { itemId: '1' }, body: { a: 2 } } })).not.toBe(
      hash,
    );
    expect(hashRequest({ ...base, request: { params: { itemId: '2' }, body: { a: 1 } } })).not.toBe(
      hash,
    );
    // Array order is meaningful.
    expect(hashRequest({ ...base, request: { params: {}, body: [1, 2] } })).not.toBe(
      hashRequest({ ...base, request: { params: {}, body: [2, 1] } }),
    );
  });
});
