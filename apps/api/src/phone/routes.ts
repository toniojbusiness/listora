/**
 * On-phone execution (docs/features/phone-execution.md): the app registers its device, then
 * claims the marketplace work waiting for it and answers each script call its runtime ran. The
 * server runs the work itself with those answers (`claimPhoneRun`, `answerPhoneCall` in
 * `@listora/automation`), so every rule of the engine holds exactly as on the cloud runner.
 */
import type { PhoneRunResult } from '@listora/api-contract';
import {
  answerPhoneCall,
  claimPhoneRun,
  nextPhoneClaimSeconds,
  PhoneCallConflictError,
  PhoneRunGoneError,
  PHONE_RUNTIME_VERSION,
  PHONE_WAIT_MAX_SECONDS,
  PhoneRuntimeMismatchError,
  readPhoneBundle,
  waitForPhoneWork,
  type PhoneRunState,
  type PhoneWorkDependencies,
} from '@listora/automation';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, notFound } from '../errors.ts';
import { deviceView, findDevice, registerDevice, touchDevice } from './devices.ts';

export interface PhoneRouteDependencies extends RouteDependencies {
  /** The work handed to phones and how it runs; undefined where phones run nothing. */
  phone: PhoneWorkDependencies | undefined;
}

export function registerPhoneRoutes(app: FastifyInstance, deps: PhoneRouteDependencies): void {
  contractRoute(app, deps, 'registerDevice', async ({ tenant, db, params, body }) => {
    const row = await registerDevice(db, tenant, params.installationId, body);
    return { status: 200, body: deviceView(row) };
  });

  contractRoute(app, deps, 'claimPhoneRun', async ({ tenant, db, body }) => {
    const phone = available(deps);
    const device = await findDevice(db, tenant, body.installationId);
    if (device === undefined) throw notFound('Device');
    await touchDevice(db, device, body.runtimeVersion);
    try {
      const run = await claimPhoneRun(phone, db, {
        accountId: tenant.accountId,
        deviceId: device.id,
        runtimeVersion: body.runtimeVersion,
        running: body.running ?? [],
        appOpen: body.appOpen === true,
      });
      const result = runResult(run);
      if (result.run !== undefined) return { status: 200, body: result };
      // Nothing to run now: the app asks again then, while it is open.
      const nextClaimInSeconds = await nextPhoneClaimSeconds(db, {
        accountId: tenant.accountId,
        deviceId: device.id,
        appOpen: body.appOpen === true,
      });
      return { status: 200, body: { nextClaimInSeconds } };
    } catch (error) {
      throw apiError(error);
    }
  });

  contractRoute(app, deps, 'waitForPhoneWork', async ({ tenant, db, body, request }) => {
    const phone = available(deps);
    const device = await findDevice(db, tenant, body.installationId);
    if (device === undefined) throw notFound('Device');
    // The wait ends when the app gives up on it (its connection closes).
    const gone = new AbortController();
    const abort = (): void => {
      gone.abort();
    };
    const socket = request.raw.socket;
    socket.once('close', abort);
    try {
      const ready = await waitForPhoneWork(
        phone,
        db,
        { accountId: tenant.accountId, deviceId: device.id },
        {
          maxMs: Math.min(body.waitSeconds, PHONE_WAIT_MAX_SECONDS) * 1000,
          signal: gone.signal,
        },
      );
      return { status: 200, body: { ready } };
    } finally {
      socket.off('close', abort);
    }
  });

  contractRoute(app, deps, 'getPhoneRuntime', async ({ query }) => {
    const bundle = await readPhoneBundle();
    return {
      status: 200,
      body: {
        runtimeVersion: PHONE_RUNTIME_VERSION,
        digest: bundle.digest,
        ...(query.have === bundle.digest ? {} : { source: bundle.source }),
      },
    };
  });

  contractRoute(app, deps, 'answerPhoneCall', async ({ tenant, db, params, body }) => {
    const phone = available(deps);
    const device = await findDevice(db, tenant, body.installationId);
    if (device === undefined) throw notFound('Device');
    try {
      const run = await answerPhoneCall(phone, {
        accountId: tenant.accountId,
        deviceId: device.id,
        runId: params.runId,
        index: Number(params.index),
        answer: body.answer,
      });
      return { status: 200, body: runResult(run) };
    } catch (error) {
      throw apiError(error);
    }
  });
}

function available(deps: PhoneRouteDependencies): PhoneWorkDependencies {
  if (deps.phone === undefined) {
    throw new ApiError(
      'marketplace_action_unavailable',
      "Listora can't run marketplace changes on your iPhone here.",
    );
  }
  return deps.phone;
}

/** A run with a call goes on; one without is over, so the app claims the next. */
function runResult(run: PhoneRunState | null): PhoneRunResult {
  const call = run?.call ?? null;
  if (run === null || call === null) return {};
  return {
    run: {
      id: run.id,
      purpose: run.purpose,
      marketplace: run.marketplace,
      ...(run.operationId === null ? {} : { operationId: run.operationId }),
      call: {
        index: call.index,
        input: call.input as unknown as Record<string, unknown>,
      },
    },
  };
}

function apiError(error: unknown): unknown {
  if (error instanceof PhoneRuntimeMismatchError) {
    return new ApiError('app_update_required', error.message, { cause: error });
  }
  if (error instanceof PhoneRunGoneError) return notFound('Phone run');
  if (error instanceof PhoneCallConflictError) {
    return new ApiError('invalid_state_transition', error.message, { cause: error });
  }
  return error;
}
