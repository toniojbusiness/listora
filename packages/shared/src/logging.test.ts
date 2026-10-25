import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger, isLogLevel, MAX_REDACTED_FIELD_DEPTH } from './logging.ts';

function memoryStream(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const lines = () =>
    chunks
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { stream, lines };
}

describe('createLogger', () => {
  it('writes structured JSON with the service name', () => {
    const { stream, lines } = memoryStream();
    createLogger({ service: 'api', level: 'info', destination: stream }).info(
      { itemId: 'item_1' },
      'hello',
    );
    expect(lines()).toEqual([
      expect.objectContaining({ service: 'api', msg: 'hello', itemId: 'item_1', level: 30 }),
    ]);
  });

  it('redacts credentials before they reach the log', () => {
    const { stream, lines } = memoryStream();
    const logger = createLogger({ service: 'worker', level: 'info', destination: stream });
    logger.info({
      connection: { refreshToken: 'rt-secret', accessToken: 'at-secret' },
      req: { headers: { authorization: 'Bearer secret' } },
    });
    const output = JSON.stringify(lines());
    expect(output).not.toContain('secret');
    expect(output).toContain('[redacted]');
  });

  it('redacts credentials at the top level and in nested objects', () => {
    const { stream, lines } = memoryStream();
    const logger = createLogger({ service: 'worker', level: 'info', destination: stream });
    logger.info({ refreshToken: 'rt-secret', password: 'pw-secret' }, 'top level');
    logger.info({ conn: { creds: { accessToken: 'at-secret' } } }, 'two levels');
    logger.info({ a: { b: { c: { d: { apiKey: 'key-secret' } } } } }, 'four levels');
    const [top, two, four] = lines();
    expect(top).toMatchObject({ refreshToken: '[redacted]', password: '[redacted]' });
    expect(two).toMatchObject({ conn: { creds: { accessToken: '[redacted]' } } });
    expect(four).toMatchObject({ a: { b: { c: { d: { apiKey: '[redacted]' } } } } });
    expect(JSON.stringify(lines())).not.toContain('secret');
  });

  it('redacts every sensitive field at every supported depth', () => {
    const { stream, lines } = memoryStream();
    const logger = createLogger({ service: 'api', level: 'info', destination: stream });
    const fields = [
      'password',
      'token',
      'accessToken',
      'refreshToken',
      'clientSecret',
      'apiKey',
      'cookie',
      'cookies',
    ];
    for (let depth = 0; depth <= MAX_REDACTED_FIELD_DEPTH; depth++) {
      let payload: Record<string, unknown> = Object.fromEntries(
        fields.map((field) => [field, `${field}-secret`]),
      );
      for (let level = 0; level < depth; level++) payload = { [`level${String(level)}`]: payload };
      logger.info(payload);
    }
    expect(lines()).toHaveLength(MAX_REDACTED_FIELD_DEPTH + 1);
    expect(JSON.stringify(lines())).not.toContain('secret');
  });

  it('respects the configured level', () => {
    const { stream, lines } = memoryStream();
    const logger = createLogger({ service: 'api', level: 'warn', destination: stream });
    logger.info('dropped');
    logger.warn('kept');
    expect(lines().map((line) => line['msg'])).toEqual(['kept']);
  });
});

describe('isLogLevel', () => {
  it('accepts pino levels and rejects anything else', () => {
    expect(isLogLevel('debug')).toBe(true);
    expect(isLogLevel('verbose')).toBe(false);
  });
});
