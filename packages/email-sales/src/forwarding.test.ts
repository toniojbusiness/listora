import { describe, expect, it } from 'vitest';

import { readForwardingConfirmation } from './forwarding.ts';
import { readMessage } from './message.ts';
import { fixture } from './test-support.ts';

const GMAIL = { name: 'Gmail', domain: 'google.com' };

describe('forwarding confirmations', () => {
  it('reads Gmail’s code and its confirmation link', async () => {
    const message = await readMessage(new TextEncoder().encode(fixture('gmail-forwarding')));
    expect(readForwardingConfirmation(GMAIL, message)).toEqual({
      provider: 'Gmail',
      code: '418273645',
      url: 'https://mail-settings.google.com/mail/vf-%5BANGjdJ-synthetic-confirmation-link%5D-fixture',
    });
  });

  it('never surfaces a link off the provider’s own domain', async () => {
    const text = fixture('gmail-forwarding').replace(
      'https://mail-settings.google.com/mail/',
      'https://mail-settings.google.com.evil.example/mail/',
    );
    const message = await readMessage(new TextEncoder().encode(text));
    expect(readForwardingConfirmation(GMAIL, message)).toMatchObject({
      code: '418273645',
      url: null,
    });
  });

  it('ignores provider mail that is not a forwarding confirmation', async () => {
    const message = await readMessage(
      new TextEncoder().encode(
        'From: Google <no-reply@google.com>\r\nSubject: Security alert\r\n\r\nA new sign-in on Mac.\r\n',
      ),
    );
    expect(readForwardingConfirmation(GMAIL, message)).toBeNull();
  });
});
