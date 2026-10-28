import { DEPOP_DRAFT_LENGTH } from '@listora/analysis';
import { DEPOP_LIMITS } from '@listora/marketplaces';
import { describe, expect, it } from 'vitest';

import { SKU_LINE_RESERVE, splitSkuLine, withSkuLine } from './sku-line.ts';

describe('the SKU line', () => {
  it('reads back what the scripts write', () => {
    expect(splitSkuLine(withSkuLine('Faded denim.\n\n#denim', 'AJ-000184'))).toEqual({
      description: 'Faded denim.\n\n#denim',
      sku: 'AJ-000184',
    });
  });

  it("leaves room in Depop's limit for the item analysis's longest draft", () => {
    // The analysis aims the Depop copy and hashtags at what is left once the line is added.
    expect(DEPOP_DRAFT_LENGTH).toBe(DEPOP_LIMITS.descriptionLength - SKU_LINE_RESERVE);
  });
});
