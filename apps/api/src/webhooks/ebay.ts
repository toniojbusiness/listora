import type { Db } from '@listora/db';
import { ebayChallengeResponse } from '@listora/marketplaces';
import { receiveEbayNotification, type NotificationVerifier } from '@listora/sales';
import type { FastifyInstance } from 'fastify';

/** Where eBay delivers notifications and sends its endpoint challenge. */
export const EBAY_WEBHOOK_PATH = '/webhooks/ebay';
/** eBay's notifications are a few kilobytes; anything far larger is not one. */
const MAX_NOTIFICATION_BYTES = 256 * 1024;
/** How long verifying (eBay's public key) and storing may take before eBay is told to retry. */
const HANDLING_DEADLINE_MS = 20_000;

export interface EbayWebhookDependencies {
  db: Db;
  verifier: NotificationVerifier;
  /** The exact public URL registered with eBay (`EBAY_NOTIFICATION_ENDPOINT`). */
  endpoint: string;
  /** The destination's verification token (`EBAY_NOTIFICATION_VERIFICATION_TOKEN`). */
  verificationToken: string;
}

/**
 * eBay's Commerce Notification endpoint (docs/ebay-notifications.md). Server-to-server: it
 * follows eBay's contract (the topics' asyncapi documents), not the app's, so it sits outside
 * `/v1` and `openapi.yaml`, like the local storage routes. eBay's signature is its only
 * authorization.
 *
 * - `GET ?challenge_code=...`: eBay's endpoint check, answered with
 *   `{"challengeResponse": sha256(code + token + endpoint)}` as `application/json`.
 * - `POST`: one notification. The body is read as the exact text eBay signed. `204` once it is
 *   verified and stored (or is one Listora ignores), `412` for a bad signature, `503` when eBay's
 *   key cannot be read, so eBay sends it again.
 */
export function registerEbayWebhookRoutes(
  app: FastifyInstance,
  deps: EbayWebhookDependencies,
): void {
  // Encapsulated, so only this route reads its body as text.
  void app.register((scope, _options, done) => {
    scope.addContentTypeParser(
      ['application/json', '*'],
      { parseAs: 'string', bodyLimit: MAX_NOTIFICATION_BYTES },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );

    scope.get(EBAY_WEBHOOK_PATH, async (request, reply) => {
      const code = (request.query as Record<string, unknown>)['challenge_code'];
      if (typeof code !== 'string' || code === '' || code.length > 512) {
        return reply.code(400).type('application/json').send({ error: 'challenge_code required' });
      }
      return reply
        .code(200)
        .header('cache-control', 'no-store')
        .type('application/json')
        .send(
          JSON.stringify({
            challengeResponse: ebayChallengeResponse(code, deps.verificationToken, deps.endpoint),
          }),
        );
    });

    scope.post(EBAY_WEBHOOK_PATH, async (request, reply) => {
      const body = typeof request.body === 'string' ? request.body : '';
      const signature = request.headers['x-ebay-signature'];
      const result = await receiveEbayNotification(
        { db: deps.db, verifier: deps.verifier, logger: request.log },
        { body, signature: typeof signature === 'string' ? signature : undefined },
        AbortSignal.timeout(HANDLING_DEADLINE_MS),
      );
      request.log.info(
        { event: 'ebay_notification', outcome: result.outcome, topic: result.topic },
        'eBay notification received',
      );
      return reply.code(result.status).send();
    });
    done();
  });
}
