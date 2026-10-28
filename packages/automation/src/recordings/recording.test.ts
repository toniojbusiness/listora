import { describe, expect, it } from 'vitest';

import { apiGetScript } from '../runner/script-session.ts';
import { elementKinds, generalPath, recordingChanges } from './diff.ts';
import { carriesFile } from './guard.ts';
import {
  compactStates,
  expandRecording,
  lineEdits,
  loadRecordings,
  parseRecording,
  RECORDED_MARKETPLACES,
  RECORDING_FORMAT,
  type CapturedState,
  type ExpandedRecording,
} from './recording.ts';
import { apiGetUrl } from './recording-backend.ts';
import { redactRecordings, unredacted } from './redact.ts';

const state = (lines: string[], url = 'https://www.depop.com/products/create/'): CapturedState => ({
  url,
  status: 200,
  data: {},
  lines,
});

function recording(overrides: Partial<ExpandedRecording> = {}): ExpandedRecording {
  return {
    format: RECORDING_FORMAT,
    marketplace: 'depop',
    name: 'form-men-tops',
    page: 'sell-form',
    host: 'phone',
    recordedOn: '2026-10-27',
    input: null,
    result: { ok: true, value: 'filled' },
    steps: ['fill in the listing'],
    events: [{ op: 'goto', url: 'https://www.depop.com/products/create/', state: 0 }],
    states: [
      state([
        '<html',
        '><body',
        '><textarea id="description"',
        '></textarea',
        '></body',
        '></html',
        '>',
      ]),
    ],
    api: [],
    ...overrides,
  };
}

describe('recordings', () => {
  it('keeps a state that changed a little as a patch of the one before, and restores it', () => {
    const base = Array.from({ length: 40 }, (_, index) => `<li id="option-${String(index)}"`);
    // Two places changed: an option picked near the top, a menu opened near the bottom.
    const opened = [...base];
    opened[5] = '<li id="option-5" aria-selected="true"';
    opened.splice(30, 0, '<ul id="size-menu" style="--display: block"', '<li id="size-m"');
    const states = [state(base), state(opened), state(['<html', '>'])];
    const compacted = compactStates(states);
    expect(compacted[0]?.html).toEqual(base);
    expect(compacted[1]?.html).toEqual({
      from: 0,
      edits: [
        { copy: [0, 5] },
        { insert: [opened[5]] },
        { copy: [6, 24] },
        { insert: [opened[30], opened[31]] },
        { copy: [30, 10] },
      ],
    });
    // Nothing in common: whole.
    expect(compacted[2]?.html).toEqual(['<html', '>']);
    const restored = expandRecording(parseRecording({ ...recording(), states: compacted }));
    expect(restored.states.map((each) => each.lines)).toEqual(states.map((each) => each.lines));
  });

  it('diffs lines that moved, repeat, or have no match, and always restores them', () => {
    const cases: [string[], string[]][] = [
      [
        ['a', 'b', 'c'],
        ['c', 'b', 'a'],
      ],
      [
        ['x', 'x', 'y', 'x'],
        ['x', 'y', 'x', 'x', 'z'],
      ],
      [[], ['a']],
      [['a'], []],
      [
        ['>', '>', '<div', '>'],
        ['>', '<div', '>', '>', '<p', '>'],
      ],
    ];
    for (const [before, after] of cases) {
      const edits = lineEdits(before, after);
      const rebuilt = edits.flatMap((edit) =>
        'copy' in edit ? before.slice(edit.copy[0], edit.copy[0] + edit.copy[1]) : edit.insert,
      );
      expect(rebuilt, JSON.stringify([before, after])).toEqual(after);
    }
  });

  it("reads the URL back out of the API read's page script", () => {
    const url = 'https://webapi.depop.com/api/v1/shop/products/?limit=24&cursor="x"';
    expect(apiGetUrl(apiGetScript(url, 'access_token'))).toBe(url);
    expect(apiGetUrl('(() => document.title)()')).toBeNull();
  });

  it('blocks a request that sends a file, and nothing else', () => {
    const request = (method: string, type?: string) => ({
      method: () => method,
      headers: () => (type === undefined ? {} : { 'content-type': type }),
    });
    expect(carriesFile(request('POST', 'multipart/form-data; boundary=x'))).toBe(true);
    expect(carriesFile(request('PUT', 'image/jpeg'))).toBe(true);
    expect(carriesFile(request('POST', 'application/octet-stream'))).toBe(true);
    expect(carriesFile(request('POST', 'application/json'))).toBe(false);
    expect(carriesFile(request('POST'))).toBe(false);
    expect(carriesFile(request('GET', 'multipart/form-data'))).toBe(false);
  });

  describe('redaction', () => {
    const live = recording({
      name: 'listings',
      page: 'shop',
      input: 'jdoe-blue-tee',
      result: {
        ok: true,
        value: { listings: [{ externalListingId: 'jdoe-blue-tee', priceCents: 4500 }] },
      },
      events: [{ op: 'goto', url: 'https://www.depop.com/jdoe/', state: 0 }],
      states: [
        {
          url: 'https://www.depop.com/jdoe/?session_token=abcdef123456',
          status: 200,
          data: {
            __STATE__: {
              user: {
                id: 71283912,
                name: 'Jane Doe',
                email: 'jane.doe@gmail.com',
                address: '12 Elm St Apt 4',
              },
              // Translations: labels, not anyone's data.
              messages: { PostalCode: 'Postal code', Email: 'Email', city: 'City' },
            },
          },
          lines: [
            '<a href="/products/jdoe-blue-tee/"',
            '>Jane Doe (jdoe) · call 415-555-0199</a',
            `><script type="text/x-replay-flight"`,
            String.raw`>self.__next_f.push([1,"6:{\"username\":\"jdoe\",\"first_name\":\"Jane\"}"])</script`,
            '><img srcset="https://media.depop.com/b1/7128/P0.jpg 1x, https://media-photos.depop.com/b1/7128/P1.webp 2x"',
            `><input type="hidden" name="csrf" value="${'Zx9'.repeat(15)}"`,
            '>',
          ],
        },
      ],
      api: [
        {
          url: 'https://webapi.depop.com/api/v1/shop/71283912/products/',
          status: 200,
          retryAfter: null,
          json: {
            products: [
              {
                slug: 'jdoe-blue-tee',
                seller_id: 71283912,
                access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqZG9lIn0.c2lnbmF0dXJlLXNpZw',
              },
            ],
          },
        },
      ],
    });

    const { recordings, report } = redactRecordings([live], { identity: ['jdoe'] });
    const redacted = recordings[0] ?? live;
    const text = JSON.stringify(redacted);

    it('replaces who the seller is everywhere, with one placeholder for each value', () => {
      expect(text).not.toMatch(
        /jdoe|Jane|Doe|gmail|71283912|415-555-0199|Elm St|media\.depop\.com|eyJ|Zx9/,
      );
      expect(redacted.input).toBe('user1-blue-tee');
      expect(redacted.result).toEqual({
        ok: true,
        value: { listings: [{ externalListingId: 'user1-blue-tee', priceCents: 4500 }] },
      });
      expect(redacted.states[0]?.lines[0]).toBe('<a href="/products/user1-blue-tee/"');
      expect(redacted.states[0]?.data).toEqual({
        __STATE__: {
          user: { id: 90000001, name: 'Name1', email: 'user1@example.com', address: 'Redacted' },
          messages: { PostalCode: 'Postal code', Email: 'Email', city: 'City' },
        },
      });
      expect(redacted.api[0]?.json).toMatchObject({
        products: [{ slug: 'user1-blue-tee', seller_id: 90000001, access_token: 'REDACTED' }],
      });
      expect(redacted.api[0]?.url).toBe('https://webapi.depop.com/api/v1/shop/90000001/products/');
      expect(report).toMatchObject({ user: 1, image: 2 });
    });

    it('replaces images, credentials, and contact details that no key names', () => {
      const lines = redacted.states[0]?.lines.join('\n') ?? '';
      expect(lines).toContain(
        'https://images.recorded.invalid/1.jpg 1x, https://images.recorded.invalid/2.webp 2x',
      );
      expect(lines).toContain('555-555-0100');
      expect(lines).toMatch(/name="csrf" value="REDACTED\d+"/);
      expect(redacted.states[0]?.url).toBe('https://www.depop.com/user1/?session_token=REDACTED1');
    });

    it('finds what a recording still holds, without repeating it', () => {
      expect(unredacted(redacted, ['jdoe'])).toEqual([]);
      const problems = unredacted(live, ['jdoe']);
      expect(problems).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^a user value under its key/),
          expect.stringMatching(/^a name value under its key/),
          'an email address',
          'a JSON web token',
          'a word that identifies the seller',
        ]),
      );
      expect(problems.join(' ')).not.toMatch(/jdoe|Jane|gmail/);
    });
  });

  describe('changes between recordings', () => {
    const page = (testids: string[]) =>
      state([
        '<html',
        '><body',
        ...testids.map((id) => `><button data-testid="${id}" class="css-1x2y3z"`),
        '></body',
        '>',
      ]);

    it('flags a page whose elements, actions, or result changed, and nothing else', () => {
      const before = recording({ states: [page(['Post', 'Price', 'Brand'])] });
      const same = recording({
        states: [page(['Post', 'Price', 'Brand'])],
        recordedOn: '2026-11-02',
      });
      expect(recordingChanges(before, same)).toEqual([]);
      const after = recording({
        states: [page(['Post', 'PriceInput', 'Brand'])],
        result: { ok: false, failure: { kind: 'error', code: 'element_missing' } },
        events: [{ op: 'goto', url: 'https://www.depop.com/products/new/', state: 0 }],
      });
      const changes = recordingChanges(before, after);
      expect(changes).toEqual([
        expect.stringMatching(/^the script's result changed: \$\.ok was true, now false/),
        expect.stringMatching(/^the script's action 1 changed/),
        '/products/create/: no longer has button[data-testid="Price"]',
        '/products/create/: now has button[data-testid="PriceInput"]',
      ]);
      expect(recordingChanges(undefined, after)).toEqual(['a new recording']);
    });

    it('generalizes ids in paths, and ignores generated ids and classes', () => {
      expect(generalPath('https://www.depop.com/products/user1-levis-trucker-jacket-blue/')).toBe(
        '/products/<id>/',
      );
      expect(generalPath('https://www.mercari.com/us/item/m12345678901/')).toBe('/us/item/<id>/');
      expect([
        ...elementKinds([
          '<div id=":r1:" class="a"',
          '><input id="priceAmount__input" name="price" type="text"',
          '>',
        ]),
      ]).toEqual(['input#priceAmount__input[name="price"][type="text"]']);
    });
  });

  it.each(RECORDED_MARKETPLACES)(
    '%s: every committed recording reads, and holds nothing personal',
    async (marketplace) => {
      for (const [name, committed] of await loadRecordings(marketplace)) {
        expect(unredacted(committed), name).toEqual([]);
        const expanded = expandRecording(committed);
        for (const event of expanded.events) {
          expect(expanded.states[event.state], `${name}: a state for each action`).toBeDefined();
        }
      }
    },
  );
});
