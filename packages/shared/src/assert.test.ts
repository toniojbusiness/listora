import { describe, expect, it } from 'vitest';

import { assertNever } from './assert.ts';

describe('assertNever', () => {
  it('throws with the unhandled value when reached at runtime', () => {
    expect(() => assertNever('surprise' as never, 'mode')).toThrow('Unhandled mode: "surprise"');
  });
});
