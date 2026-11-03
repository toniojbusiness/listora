/**
 * `readPageData`, the read every backend's `pageData` runs in the page (and the iPhone app's
 * web view runs as MarketplacePage.pageDataRead): a global, or a dotted path into one.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { parsePageData, readPageData } from './script-session.ts';

const scope = globalThis as Record<string, unknown>;

describe('readPageData', () => {
  afterEach(() => {
    delete scope['__TEST_STATE__'];
  });

  it('reads a global, or only the part of it at a dotted path', () => {
    scope['__TEST_STATE__'] = {
      $_search: { gridData: { data: [{ id: 'a' }], total: 3 } },
      big: 'x',
    };
    expect(parsePageData(readPageData('__TEST_STATE__'))).toMatchObject({ big: 'x' });
    expect(parsePageData(readPageData('__TEST_STATE__.$_search.gridData.data'))).toEqual([
      { id: 'a' },
    ]);
    expect(readPageData('__TEST_STATE__.$_search.gridData.total')).toBe('3');
  });

  it('is null for a global or a path the page does not have', () => {
    scope['__TEST_STATE__'] = { $_search: { gridData: null, count: 2 } };
    expect(readPageData('__NO_SUCH_GLOBAL__')).toBeNull();
    expect(readPageData('__TEST_STATE__.$_search.gridData.data')).toBeNull();
    expect(readPageData('__TEST_STATE__.$_search.count.more')).toBeNull();
    expect(readPageData('__TEST_STATE__.$_search.missing')).toBeNull();
  });
});
