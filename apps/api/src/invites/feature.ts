import type { ApiFeature } from '../features.ts';

import { registerInviteRoutes } from './routes.ts';

/** Invites: the owner's invites and the people who joined, and the invitee's redemption. */
export const feature: ApiFeature = { registerRoutes: registerInviteRoutes };
