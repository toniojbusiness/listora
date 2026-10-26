/**
 * Where an automation connection's automated steps run, as Link accounts and Marketplaces both
 * show it (docs/features/phone-execution.md): in Listora's cloud, or on the iPhone that linked
 * it, with what waits for that phone. Connections of other modes run where their mode does and
 * have no such description.
 */
import { sql } from 'kysely';

import type { DbExecutor, ExecutionLocation } from '@listora/db';

export interface ExecutionState {
  /** The account's devices by id. */
  devices: ReadonlyMap<string, { installationId: string; name: string }>;
  /** What waits for the phone, by connection id. */
  waiting: ReadonlyMap<string, { count: number; since: Date }>;
  /** The connections whose session check waits for the phone. */
  checksWaiting: ReadonlySet<string>;
}

export interface ExecutionView {
  location: ExecutionLocation;
  label: string;
  device?: { installationId: string; name: string };
  waiting?: { count: number; since: Date };
}

/** What the session's description needs of where it runs (`describeAutomationSession`). */
export function phoneSessionState(
  connection: { id: string; runs_on: ExecutionLocation; phone_device_id: string | null },
  state: ExecutionState,
): { linked: boolean; checkWaiting: boolean } | undefined {
  if (connection.runs_on !== 'phone') return undefined;
  return {
    linked: connection.phone_device_id !== null && state.devices.has(connection.phone_device_id),
    checkWaiting: state.checksWaiting.has(connection.id),
  };
}

export function describeExecution(
  connection: {
    id: string;
    mode: string;
    runs_on: ExecutionLocation;
    phone_device_id: string | null;
  },
  state: ExecutionState,
): ExecutionView | undefined {
  if (connection.mode !== 'automation') return undefined;
  if (connection.runs_on === 'cloud')
    return { location: 'cloud', label: "Runs in Listora's cloud" };
  const device =
    connection.phone_device_id === null ? undefined : state.devices.get(connection.phone_device_id);
  const waiting = state.waiting.get(connection.id);
  if (device === undefined) {
    return {
      location: 'phone',
      label: 'Link it on your iPhone to run it there',
      ...(waiting === undefined ? {} : { waiting }),
    };
  }
  return {
    location: 'phone',
    label: 'Runs on your iPhone',
    device,
    ...(waiting === undefined ? {} : { waiting }),
  };
}

/** The account's devices, and the work waiting for its phones, by connection. */
export async function accountExecutionState(
  db: DbExecutor,
  accountId: string,
): Promise<ExecutionState> {
  const devices = await db
    .selectFrom('app_device')
    .select(['id', 'installation_id', 'name'])
    .where('account_id', '=', accountId)
    .execute();
  const waiting = await db
    .selectFrom('phone_work')
    .select([
      'connection_id',
      sql<number>`count(*)::int`.as('count'),
      sql<Date>`min(waiting_since)`.as('since'),
      sql<boolean>`bool_or(purpose = 'session_check')`.as('check_waiting'),
    ])
    .where('account_id', '=', accountId)
    .groupBy('connection_id')
    .execute();
  return {
    devices: new Map(
      devices.map((device) => [
        device.id,
        { installationId: device.installation_id, name: device.name },
      ]),
    ),
    waiting: new Map(
      waiting.map((row) => [row.connection_id, { count: row.count, since: row.since }]),
    ),
    checksWaiting: new Set(
      waiting.filter((row) => row.check_waiting).map((row) => row.connection_id),
    ),
  };
}
