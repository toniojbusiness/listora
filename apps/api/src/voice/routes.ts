import { AiCallError, AiGuardError, type AiClient } from '@listora/ai';
import { interpretVoiceCorrection } from '@listora/analysis';
import { assertNever, photoSetHash } from '@listora/shared';
import type { FastifyInstance } from 'fastify';

import { aiGuardApiError } from '../analyses/guards.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import { findItem } from '../items/repository.ts';
import { listPhotoRows } from '../photos/repository.ts';

export interface VoiceRouteDependencies extends RouteDependencies {
  ai: AiClient;
  now: () => Date;
}

/**
 * `interpretVoiceCorrection`: the text model's reading of the phrases of a spoken correction
 * the app's own parser could not map. It changes nothing: the answer is a proposal the app
 * shows for the seller to accept, and the seller's accepted changes are saved with
 * `replaceItem` like any edit. The call goes through the AI client, so it is metered and
 * counted in the daily budget, and an idempotent retry replays the stored answer instead of
 * paying again.
 */
export function registerVoiceRoutes(app: FastifyInstance, deps: VoiceRouteDependencies): void {
  contractRoute(app, deps, 'interpretVoiceCorrection', async ({ tenant, db, params, body }) => {
    const transcript = body.transcript.trim();
    if (transcript === '') {
      throw validationFailed([{ field: 'transcript', message: 'Say or type a correction.' }]);
    }
    const item = await findItem(db, tenant, params.itemId);
    if (!item) throw notFound('Item');
    // The call is about the item its photos show; the fake provider keys its answers by it.
    const photos = await listPhotoRows(db, tenant, item.id);
    const hash = photoSetHash(
      photos.flatMap((photo) => (photo.sha256 === null ? [] : [photo.sha256])),
    );
    try {
      const correction = await interpretVoiceCorrection(deps.ai, {
        accountId: tenant.accountId,
        userId: tenant.userId,
        itemId: item.id,
        photoSetHash: hash,
        transcript,
      });
      return { status: 200, body: correction };
    } catch (error) {
      throw voiceFailure(error, deps.now());
    }
  });
}

function voiceFailure(error: unknown, now: Date): unknown {
  if (error instanceof AiGuardError) {
    return aiGuardApiError(error, guardMessage(error), now);
  }
  if (error instanceof AiCallError) {
    return new ApiError(
      'service_unavailable',
      "Listora couldn't work out that correction just now. Try again, or edit the details by hand.",
      { cause: error },
    );
  }
  return error;
}

function guardMessage(error: AiGuardError): string {
  const { reason } = error;
  switch (reason.kind) {
    case 'kill_switch':
      return 'AI is paused right now, so Listora can only use corrections it understands on your iPhone. Edit the rest by hand.';
    case 'account_blocked':
      return 'AI is turned off for this account, so Listora can only use corrections it understands on your iPhone. Contact support.';
    case 'daily_budget':
      return "Today's AI budget for this account is used up, so Listora can only use corrections it understands on your iPhone until tomorrow.";
    case 'quota':
      return "Your plan's AI limit is reached.";
    default:
      return assertNever(reason);
  }
}
