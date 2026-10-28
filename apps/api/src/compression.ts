import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

import type { FastifyInstance, FastifyReply } from 'fastify';

/** Answers smaller than this go as they are: compressing them gains less than it costs. */
export const COMPRESS_THRESHOLD_BYTES = 1024;

/**
 * Brotli's quality: 4 compresses JSON about as fast as gzip's default and a little smaller.
 * Its default (11) costs far more CPU than a fraction of a vCPU can spare per request.
 */
const BROTLI_QUALITY = 4;

/** JSON (the API's answers and errors), JavaScript, and text. Never images: JPEG is compressed. */
const COMPRESSIBLE = /^(?:application\/(?:json|javascript|[\w.-]+\+json)|text\/)/i;

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

type Encoding = 'br' | 'gzip';

/**
 * Compresses every answer of at least `COMPRESS_THRESHOLD_BYTES` whose type is compressible
 * (docs/features/performance.md, "Response compression"): brotli, or gzip for a client that
 * accepts only that. API Gateway's HTTP API does not compress, and the app's URLSession asks
 * for both and decodes them itself. A hook on the root, so it covers every route whenever it
 * was registered; photos and other binary bodies are never compressed. Request bodies are not
 * decompressed: every client sends its JSON as it is.
 */
export function registerCompression(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
    if (!compressible(reply)) return payload;
    const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
    if (body.length < COMPRESS_THRESHOLD_BYTES) return payload;
    reply.header('vary', varyWithEncoding(reply.getHeader('vary')));
    const encoding = acceptedEncoding(request.headers['accept-encoding']);
    if (encoding === null) return payload;
    const compressed =
      encoding === 'br'
        ? await brotli(body, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
              [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
            },
          })
        : await gzipped(body);
    reply.header('content-encoding', encoding);
    reply.removeHeader('content-length');
    return compressed;
  });
}

function compressible(reply: FastifyReply): boolean {
  if (reply.getHeader('content-encoding') !== undefined) return false;
  const type = reply.getHeader('content-type');
  return typeof type === 'string' && COMPRESSIBLE.test(type);
}

/**
 * The encoding to send for an `Accept-Encoding` header: brotli when accepted, else gzip, else
 * none. A coding with `q=0` is refused; `*` accepts both.
 */
export function acceptedEncoding(header: string | string[] | undefined): Encoding | null {
  if (header === undefined) return null;
  const accepted = new Map<string, number>();
  for (const part of (Array.isArray(header) ? header.join(',') : header).split(',')) {
    const [name = '', ...parameters] = part.trim().toLowerCase().split(';');
    if (name === '') continue;
    const q = parameters.map((p) => p.trim()).find((p) => p.startsWith('q='));
    accepted.set(name, q === undefined ? 1 : Number(q.slice(2)) || 0);
  }
  const wildcard = accepted.get('*') ?? 0;
  for (const encoding of ['br', 'gzip'] as const) {
    if ((accepted.get(encoding) ?? wildcard) > 0) return encoding;
  }
  return null;
}

function varyWithEncoding(current: ReturnType<FastifyReply['getHeader']>): string {
  const values = (Array.isArray(current) ? current.join(',') : String(current ?? ''))
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (values.some((value) => value === '*' || value.toLowerCase() === 'accept-encoding')) {
    return values.join(', ');
  }
  return [...values, 'accept-encoding'].join(', ');
}
