import { PUBLIC_CACHE_CONTROL } from '@listora/photos';
import {
  CHECKSUM_SHA256_HEADER,
  isPublicKey,
  isStorageKey,
  LOCAL_STORAGE_ROUTE_PREFIX,
  type LocalDiskStorage,
} from '@listora/storage';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiError, notFound } from '../errors.ts';

/** The contract's per-file upload limit (`UploadFileCreate.byteSize`). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Serves `LocalDiskStorage` the way S3 and CloudFront serve production storage, so the app
 * runs the same upload code against both: signed PUTs of upload targets, and GETs of public
 * keys. Registered only when STORAGE_DRIVER is `local`. These routes sit outside `/v1` and
 * the contract: the URL's signature (PUT) or its unguessable key (GET) is the authorization.
 */
export function registerLocalStorageRoutes(app: FastifyInstance, storage: LocalDiskStorage): void {
  // Encapsulated, so only these routes accept raw (non-JSON) bodies.
  void app.register((scope, _options, done) => {
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.put(`${LOCAL_STORAGE_ROUTE_PREFIX}*`, async (request, reply) => {
      const key = keyOf(request);
      if (!isStorageKey(key)) throw notFound('Object');
      if (!(request.body instanceof Buffer)) {
        throw new ApiError('invalid_request', 'Send the file bytes with the signed content type.');
      }
      const query = request.query as Record<string, string | undefined>;
      const result = await storage.acceptUpload({
        key,
        expires: query['expires'],
        signature: query['signature'],
        contentType: header(request, 'content-type'),
        checksumSha256: header(request, CHECKSUM_SHA256_HEADER),
        body: new Uint8Array(request.body),
      });
      if (result.status === 'stored') return reply.code(200).send();
      switch (result.reason) {
        case 'expired':
          throw new ApiError('forbidden', 'This upload link has expired. Ask for a new one.');
        case 'bad_signature':
          throw new ApiError(
            'forbidden',
            'This upload link does not match the request. Send exactly the signed headers.',
          );
        case 'checksum_mismatch':
          throw new ApiError('invalid_request', 'The file does not match its SHA-256 checksum.');
      }
    });

    scope.get(`${LOCAL_STORAGE_ROUTE_PREFIX}*`, async (request, reply) => {
      const key = keyOf(request);
      // Only public keys are ever served; private ones read as missing.
      const body = isPublicKey(key) ? await storage.get(key) : undefined;
      if (body === undefined) throw notFound('Object');
      return reply
        .header('content-type', key.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream')
        .header('cache-control', PUBLIC_CACHE_CONTROL)
        .header('x-content-type-options', 'nosniff')
        .send(Buffer.from(body));
    });
    done();
  });
}

function keyOf(request: FastifyRequest): string {
  return (request.params as Record<string, string | undefined>)['*'] ?? '';
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}
