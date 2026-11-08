import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  describeValue,
  MAX_LOGGED_ISSUES,
  MAX_LOGGED_VALUE_LENGTH,
  notJson,
  redactText,
  schemaIssues,
} from './invalid-output.ts';

describe('redactText', () => {
  it('masks contact details and cuts long text, saying how long it was', () => {
    expect(redactText('write to seller@example.com or call +1 (555) 010-2030')).toBe(
      'write to <email> or call <number>',
    );
    expect(redactText('see https://example.com/listing/1?ref=me')).toBe('see <url>');
    const long = 'x'.repeat(200);
    expect(redactText(long)).toBe(`${'x'.repeat(MAX_LOGGED_VALUE_LENGTH)}… (200 chars)`);
    // Sizes and short numbers stay readable.
    expect(redactText('32x30, 100% cotton, size 10')).toBe('32x30, 100% cotton, size 10');
  });
});

describe('describeValue', () => {
  it('shows text, numbers, and booleans, and lists and objects only by their size and keys', () => {
    expect(describeValue('Olive')).toBe('"Olive"');
    expect(describeValue(7)).toBe('7');
    expect(describeValue(false)).toBe('false');
    expect(describeValue(null)).toBe('null');
    expect(describeValue(undefined)).toBe('(missing)');
    expect(describeValue(['secret listing copy', 'more'])).toBe('(list of 2)');
    expect(describeValue({ title: 'secret', description: 'copy' })).toBe(
      '(object: title, description)',
    );
  });
});

describe('schemaIssues', () => {
  const schema = z.object({
    colors: z.array(z.enum(['black', 'white'])),
    tags: z.array(z.string().regex(/^[a-z]+$/)),
    note: z.string().max(5),
  });

  it('names each refused value by its path, with what the model wrote there', () => {
    const answer = {
      colors: ['black', 'Olive'],
      tags: ['ok', 'vintage_tee'],
      note: 'mail me at a@b.co',
    };
    const parsed = schema.safeParse(answer);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(schemaIssues(answer, parsed.error)).toEqual({
      kind: 'schema',
      issues: [
        { path: 'colors.1', code: 'invalid_value', received: '"Olive"' },
        { path: 'tags.1', code: 'invalid_format', received: '"vintage_tee"' },
        { path: 'note', code: 'too_big', received: '"mail me at <email>"' },
      ],
    });
  });

  it('keeps at most the first issues, and names a missing value', () => {
    const many = z.object(
      Object.fromEntries(
        Array.from({ length: 15 }, (_, index) => [`k${String(index)}`, z.string()]),
      ),
    );
    const parsed = many.safeParse({});
    if (parsed.success) throw new Error('expected a failure');
    const detail = schemaIssues({}, parsed.error);
    expect(detail.kind === 'schema' && detail.issues).toHaveLength(MAX_LOGGED_ISSUES);
    expect(detail.kind === 'schema' && detail.issues[0]).toEqual({
      path: 'k0',
      code: 'invalid_type',
      received: '(missing)',
    });
  });
});

describe('notJson', () => {
  it('gives the length and the redacted start of an answer that is not JSON', () => {
    expect(notJson('  The color is red; ask me at me@example.com')).toEqual({
      kind: 'not_json',
      length: 44,
      start: 'The color is red; ask me at <email>',
    });
  });
});
