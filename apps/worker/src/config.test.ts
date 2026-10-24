import { describe, expect, it } from 'vitest';

import { loadWorkerConfig } from './config.ts';

describe('loadWorkerConfig', () => {
  it('defaults LOG_LEVEL to info', () => {
    expect(loadWorkerConfig({})).toEqual({ logLevel: 'info' });
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadWorkerConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL must be one of/);
  });
});
