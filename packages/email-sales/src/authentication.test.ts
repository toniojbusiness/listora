import { describe, expect, it } from 'vitest';

import {
  authenticationFromHeaders,
  checkSender,
  parseAuthenticationResults,
  UNVERIFIED,
} from './authentication.ts';
import { readMessage } from './message.ts';
import { deliver, fixture } from './test-support.ts';

const TO = 'sales+aaaaaaaaaaaaaaaaaaaa@in.listora.test';

async function auth(raw: Uint8Array) {
  return authenticationFromHeaders(await readMessage(raw), 'mx.listora.test');
}

describe('Authentication-Results', () => {
  it('reads SES’s header: SPF and the signing domains that passed', () => {
    expect(
      parseAuthenticationResults(
        'amazonses.com; spf=pass (spfCheck: domain of gmail.com designates 1.2.3.4 as permitted sender; really) client-ip=1.2.3.4; envelope-from=jane+caf_=x@gmail.com; helo=mail.google.com; dkim=pass header.i=@poshmark.com; dkim=fail header.d=evil.example; dkim=pass header.i=jane@gmail.com; dmarc=pass header.from=poshmark.com;',
      ),
    ).toEqual({
      authservId: 'amazonses.com',
      spf: 'pass',
      dkimPassDomains: ['poshmark.com', 'gmail.com'],
    });
  });

  it('trusts only the first header, and only from the trusted receiver', async () => {
    const forged = deliver(fixture('poshmark-sold'), {
      to: TO,
      spf: 'fail',
      dkim: null,
      forgedHeaders: [
        'Authentication-Results: mx.listora.test; spf=pass; dkim=pass header.d=poshmark.com',
      ],
    });
    expect(await auth(forged)).toMatchObject({ spf: 'fail', dkimPassDomains: [] });
    const elsewhere = deliver(fixture('poshmark-sold'), {
      to: TO,
      dkim: 'poshmark.com',
      receiver: 'mx.attacker.example',
    });
    expect(await auth(elsewhere)).toEqual(UNVERIFIED);
  });
});

describe('checkSender', () => {
  const passing = { spf: 'pass', dkimPassDomains: ['poshmark.com'], flagged: false } as const;

  it('accepts SPF pass with a DKIM signature of the sender’s domain or a subdomain', () => {
    expect(checkSender(passing, 'poshmark.com')).toEqual({ ok: true });
    expect(
      checkSender({ ...passing, dkimPassDomains: ['mail.poshmark.com'] }, 'poshmark.com'),
    ).toEqual({ ok: true });
  });

  it('rejects a failed SPF, a missing or unaligned DKIM signature, and a flagged message', () => {
    expect(checkSender({ ...passing, spf: 'softfail' }, 'poshmark.com')).toEqual({
      ok: false,
      reason: 'SPF did not pass (softfail).',
    });
    for (const domains of [[], ['gmail.com'], ['notposhmark.com'], ['poshmark.com.evil.example']]) {
      expect(checkSender({ ...passing, dkimPassDomains: domains }, 'poshmark.com')).toEqual({
        ok: false,
        reason: 'No DKIM signature of poshmark.com passed.',
      });
    }
    expect(checkSender({ ...passing, flagged: true }, 'poshmark.com').ok).toBe(false);
  });
});
