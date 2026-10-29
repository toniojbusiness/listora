/**
 * The seller's registered devices (`app_device`): the app registers its installation on every
 * launch and whenever its push token changes. A token belongs to one installation, so
 * registering it moves it there, but only within the account or from the same installation (a
 * phone signed into another account keeps its installation id, which lives in its Keychain):
 * another account's installation that sends a token it somehow knows gets no push, and the
 * token stays where it was (docs/features/push.md). The device that links a marketplace runs its
 * automated steps when they run on the phone (docs/features/phone-execution.md).
 */
import type { Device, DeviceRegistration } from '@listora/api-contract';
import { inTransaction, type AppDeviceTable, type DbExecutor } from '@listora/db';
import { sql, type Selectable } from 'kysely';

import type { Tenant } from '../tenancy.ts';

type DeviceRow = Selectable<AppDeviceTable>;

export interface RegisteredDevice {
  row: DeviceRow;
  /**
   * The push token was not stored: another account's installation holds it, and only that
   * installation (or another of that account's) can move it.
   */
  pushTokenRefused: boolean;
}

export async function registerDevice(
  db: DbExecutor,
  tenant: Tenant,
  installationId: string,
  registration: DeviceRegistration,
): Promise<RegisteredDevice> {
  return inTransaction(db, async (trx) => {
    let token = registration.pushToken ?? null;
    let pushTokenRefused = false;
    if (token !== null) {
      const holders = await trx
        .selectFrom('app_device')
        .select(['account_id', 'installation_id'])
        .where('push_token', '=', token)
        .forUpdate()
        .execute();
      // Within the account, or from the same installation under another account (the phone
      // signed into this one), the token moves here; from anywhere else it stays.
      pushTokenRefused = holders.some(
        (holder) =>
          holder.account_id !== tenant.accountId && holder.installation_id !== installationId,
      );
      if (pushTokenRefused) {
        token = null;
      } else {
        await trx
          .updateTable('app_device')
          .set({ push_token: null, push_environment: null })
          .where('push_token', '=', token)
          .where((eb) =>
            eb.or([
              eb('account_id', '<>', tenant.accountId),
              eb('installation_id', '<>', installationId),
            ]),
          )
          .execute();
      }
    }
    const values = {
      user_id: tenant.userId,
      name: registration.name,
      platform: registration.platform,
      app_version: registration.appVersion ?? null,
      runtime_version: registration.runtimeVersion ?? null,
      push_token: token,
      push_environment: token === null ? null : (registration.pushEnvironment ?? 'production'),
      last_seen_at: sql<Date>`now()`,
    };
    const row = await trx
      .insertInto('app_device')
      .values({ account_id: tenant.accountId, installation_id: installationId, ...values })
      .onConflict((conflict) =>
        conflict.columns(['account_id', 'installation_id']).doUpdateSet(values),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return { row, pushTokenRefused };
  });
}

/** The account's device with this installation id, or `undefined`. */
export async function findDevice(
  db: DbExecutor,
  tenant: Tenant,
  installationId: string,
): Promise<DeviceRow | undefined> {
  return db
    .selectFrom('app_device')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('installation_id', '=', installationId)
    .executeTakeFirst();
}

/** Notes that the device was seen (it asked for work), and the runtime version it speaks. */
export async function touchDevice(
  db: DbExecutor,
  device: Pick<DeviceRow, 'account_id' | 'id'>,
  runtimeVersion: number,
): Promise<void> {
  await db
    .updateTable('app_device')
    .set({ last_seen_at: sql<Date>`now()`, runtime_version: runtimeVersion })
    .where('account_id', '=', device.account_id)
    .where('id', '=', device.id)
    .execute();
}

export function deviceView(row: DeviceRow): Device {
  return {
    installationId: row.installation_id,
    name: row.name,
    platform: row.platform,
    pushEnabled: row.push_token !== null,
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}
