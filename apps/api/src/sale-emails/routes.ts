import {
  dropInInbox,
  ensureSaleEmailInbox,
  findSaleEmailInbox,
  inboundDomainOf,
  MAX_MESSAGE_BYTES,
  saveAskBeforeDelist,
  type EmailIngestConfig,
} from '@listora/email-sales';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { validationFailed } from '../errors.ts';
import { saleEmailsView } from './views.ts';

export interface SaleEmailsDependencies {
  /** EMAIL_* (@listora/email-sales): the forwarding addresses' domain, and the dev drop folder. */
  ingest: EmailIngestConfig;
}

export interface SaleEmailRouteDependencies extends RouteDependencies {
  saleEmails: SaleEmailsDependencies;
}

/**
 * Email sale detection (docs/features/email-sales.md): `getSaleEmails` (the account's
 * forwarding address, made on first use, its setup steps and status) and
 * `replaceSaleEmailSettings` ("ask before auto-delist"). With the folder driver
 * (development), `POST /dev/email` drops a raw message (`message/rfc822`) in the inbox folder,
 * where the worker reads it within a minute.
 */
export function registerSaleEmailRoutes(
  app: FastifyInstance,
  deps: SaleEmailRouteDependencies,
): void {
  const { ingest } = deps.saleEmails;
  const inboundDomain = inboundDomainOf(ingest);

  contractRoute(app, deps, 'getSaleEmails', async ({ tenant, db }) => {
    const inbox =
      inboundDomain === undefined
        ? await findSaleEmailInbox(db, tenant.accountId)
        : await ensureSaleEmailInbox(db, tenant.accountId);
    return { status: 200, body: saleEmailsView(inbox, inboundDomain) };
  });

  contractRoute(app, deps, 'replaceSaleEmailSettings', async ({ tenant, db, body }) => {
    const saved = await saveAskBeforeDelist(db, tenant.accountId, body.askBeforeDelist);
    return { status: 200, body: saleEmailsView(saved, inboundDomain) };
  });

  if (ingest.driver === 'folder') {
    const { inboxDir } = ingest;
    // Its own scope, so only this route takes a raw message body.
    void app.register((scope, _options, registered) => {
      scope.addContentTypeParser(
        'message/rfc822',
        { parseAs: 'buffer', bodyLimit: MAX_MESSAGE_BYTES },
        (_request, body, done) => {
          done(null, body);
        },
      );
      scope.post('/dev/email', async (request, reply) => {
        const body = request.body;
        if (!Buffer.isBuffer(body) || body.byteLength === 0) {
          throw validationFailed(
            [{ field: 'body', message: 'is required' }],
            'Send the raw message as message/rfc822.',
          );
        }
        const file = await dropInInbox(inboxDir, body);
        request.log.info({ file }, 'dev email dropped in the inbox folder');
        return reply.code(202).send({ file });
      });
      registered();
    });
  }
}
