import {
  answerImportQuestion,
  AnswerRefusedError,
  ImportRefusedError,
  startListingImport,
} from '@listora/imports';
import type { FastifyInstance } from 'fastify';

import { contractRoute } from '../contract/routes.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import type { ApiRouteContext } from '../features.ts';
import { findImport, importMarketplaces, importQuestions, importView } from './views.ts';

/**
 * Importing the seller's listings (docs/features/imports.md): the marketplaces an import can
 * start on and their newest imports, starting one, its progress, and its questions and their
 * answers.
 */
export function registerImportRoutes(app: FastifyInstance, deps: ApiRouteContext): void {
  contractRoute(app, deps, 'listListingImports', async ({ tenant, db }) => ({
    status: 200,
    body: { marketplaces: await importMarketplaces(db, tenant) },
  }));

  contractRoute(app, deps, 'startListingImport', async ({ tenant, db, body }) => {
    try {
      const started = await startListingImport(db, {
        accountId: tenant.accountId,
        marketplace: body.marketplace,
      });
      return { status: 202, body: importView(started) };
    } catch (error) {
      if (!(error instanceof ImportRefusedError)) throw error;
      switch (error.code) {
        case 'not_linked':
          throw new ApiError('marketplace_not_connected', error.message);
        case 'running':
          throw new ApiError('already_exists', error.message);
        case 'unsupported':
          throw new ApiError('marketplace_action_unavailable', error.message);
      }
    }
  });

  contractRoute(app, deps, 'getListingImport', async ({ tenant, db, params }) => {
    const found = await findImport(db, tenant, params.importId);
    if (found === undefined) throw notFound('Import');
    return { status: 200, body: importView(found) };
  });

  contractRoute(app, deps, 'listListingImportQuestions', async ({ tenant, db, params }) => {
    const found = await findImport(db, tenant, params.importId);
    if (found === undefined) throw notFound('Import');
    return {
      status: 200,
      body: { questions: await importQuestions(db, tenant, found.id, deps.storage) },
    };
  });

  contractRoute(app, deps, 'answerListingImportQuestion', async ({ tenant, db, params, body }) => {
    const found = await findImport(db, tenant, params.importId);
    if (found === undefined) throw notFound('Import');
    if (body.answer === 'same_item' && body.itemId === undefined) {
      throw validationFailed(
        [{ field: 'itemId', message: 'is required for same_item' }],
        'Say which item it is.',
      );
    }
    try {
      await answerImportQuestion(
        db,
        {
          accountId: tenant.accountId,
          userId: tenant.userId,
          importId: found.id,
          entryId: params.questionId,
        },
        body.answer === 'same_item'
          ? { answer: 'same_item', itemId: body.itemId ?? '' }
          : { answer: body.answer },
      );
    } catch (error) {
      if (!(error instanceof AnswerRefusedError)) throw error;
      switch (error.code) {
        case 'not_found':
          throw notFound('Question');
        case 'answered':
          throw new ApiError('invalid_state_transition', error.message);
        case 'not_a_candidate':
          throw validationFailed([{ field: 'itemId', message: error.message }], error.message);
        case 'listed_there':
          throw new ApiError('marketplace_action_unavailable', error.message);
      }
    }
    const updated = await findImport(db, tenant, found.id);
    if (updated === undefined) throw notFound('Import');
    return { status: 200, body: importView(updated) };
  });
}
