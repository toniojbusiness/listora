import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { expectShape } from './page-data.ts';

describe('a Depop page whose data changed', () => {
  const schema = z.object({ objects: z.array(z.object({ id: z.string() })) });

  it('says which field is missing and which fields it has instead, by name only', () => {
    expect(() =>
      expectShape(schema, { offers: [{ id: 'secret-id' }], meta: { end: true } }, 'web API'),
    ).toThrow("Depop's web API no longer has the objects Listora reads (it has: offers, meta)");
  });

  it('never repeats a value it read', () => {
    expect(() => expectShape(schema, { objects: 'buyer@example.com' }, 'web API')).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('buyer@example.com') as unknown,
      }),
    );
  });

  it('says when the answer is not an object at all', () => {
    expect(() => expectShape(schema, null, 'web API')).toThrow('(it is null)');
    expect(() => expectShape(schema, [], 'web API')).toThrow('(it is a list)');
  });
});
