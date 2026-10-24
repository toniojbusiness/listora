import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger, isLogLevel } from './logging.ts';

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
