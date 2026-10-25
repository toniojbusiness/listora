import { describe, expect, it } from 'vitest';

import { automationProfile } from '../profiles.ts';
import { isPrivateHost, requestAllowed } from './network.ts';

describe('isPrivateHost', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.1',
    '169.254.169.254',
    '169.254.170.2',
    '100.64.0.1',
    '0.0.0.0',
    '[::1]',
    '[::]',
    '[fd00::1]',
    '[fe80::1]',
    '[::ffff:127.0.0.1]',
    '[::ffff:a9fe:a9fe]',
    'localhost',
    'api.localhost',
    'ip-10-0-0-1.ec2.internal',
    'printer.local',
  ])('treats %s as private', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each(['poshmark.com', 'di2ponv0v5otw.cloudfront.net', '8.8.8.8', '[2606:4700::1111]'])(
    'treats %s as public',
    (host) => {
      expect(isPrivateHost(host)).toBe(false);
    },
  );

  it('sees through the hostname URL gives an IPv4-mapped address', () => {
    expect(new URL('http://[::ffff:169.254.169.254]/').hostname).toBe('[::ffff:a9fe:a9fe]');
    expect(isPrivateHost(new URL('http://[::ffff:169.254.169.254]/').hostname)).toBe(true);
  });
});

describe('requestAllowed', () => {
  const profile = automationProfile('poshmark');

  it("lets the main frame load only the marketplace's own origins", () => {
    expect(requestAllowed('https://poshmark.com/closet/ana', true, profile)).toBe(true);
    expect(requestAllowed('https://www.poshmark.com/', true, profile)).toBe(true);
    expect(requestAllowed('https://evil.example/phish', true, profile)).toBe(false);
    expect(requestAllowed('http://poshmark.com/', true, profile)).toBe(false);
    expect(requestAllowed('data:text/html,hi', true, profile)).toBe(false);
  });

  it('lets pages load assets from public hosts, never from private addresses', () => {
    expect(requestAllowed('https://cdn.example/app.js', false, profile)).toBe(true);
    expect(requestAllowed('wss://realtime.poshmark.com/socket', false, profile)).toBe(true);
    expect(requestAllowed('data:image/png;base64,AAAA', false, profile)).toBe(true);
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.170.2/v2/credentials/x',
      'http://10.0.3.7:5432/',
      'http://localhost:3000/health',
      'ws://127.0.0.1:9222/devtools',
      'http://[::1]/',
      'ftp://files.example/',
      'not a url',
    ]) {
      expect(requestAllowed(url, false, profile), url).toBe(false);
    }
  });

  it("allows a local stand-in when it is the profile's own origin", () => {
    const local = { origins: ['http://127.0.0.1:4300'] };
    expect(requestAllowed('http://127.0.0.1:4300/listings/new', true, local)).toBe(true);
    expect(requestAllowed('ws://127.0.0.1:4300/live', false, local)).toBe(true);
    expect(requestAllowed('http://localhost:4300/elsewhere', true, local)).toBe(false);
    expect(requestAllowed('http://127.0.0.1:4301/', false, local)).toBe(false);
  });
});
