import { describe, expect, it } from 'vitest';

import { NetworkLog } from './network-log.ts';

describe('NetworkLog', () => {
  it('counts by origin only, never a path or a query', () => {
    const log = new NetworkLog();
    log.refused('http://localhost:8080/elsewhere?image');
    log.refused('http://localhost:8080/other');
    log.response('https://poshmark.com/vm-rest/users/ana/drafts?token=secret', 403);
    log.response('https://poshmark.com/closet/ana', 200);
    log.failed('https://cdn.example.com/a.js?x=1', 'net::ERR_CONNECTION_RESET');
    // A refusal shows up as a failed request too; it is counted once, as refused.
    log.failed('http://localhost:8080/elsewhere?image', 'net::ERR_BLOCKED_BY_CLIENT');
    expect(log.summary()).toEqual({
      refused: { 'http://localhost:8080': 2 },
      errors: { 'https://poshmark.com 403': 1 },
      failed: { 'https://cdn.example.com net::ERR_CONNECTION_RESET': 1 },
    });
    expect(JSON.stringify(log.summary())).not.toMatch(/drafts|token|secret|elsewhere/);
  });

  it('says nothing when nothing went wrong, and stays bounded when everything did', () => {
    const quiet = new NetworkLog();
    quiet.response('https://poshmark.com/', 200);
    expect(quiet.summary()).toBeUndefined();

    const noisy = new NetworkLog();
    for (let host = 0; host < 50; host += 1) noisy.refused(`http://10.0.0.${String(host)}/`);
    expect(Object.keys(noisy.summary()?.refused ?? {})).toHaveLength(20);
  });
});
