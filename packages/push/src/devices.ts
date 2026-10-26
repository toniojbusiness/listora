/**
 * Where an account's pushes go: the APNs device tokens its devices registered
 * (`app_device`, registered by the app through the API's `registerDevice`).
 */
import type { Db, PushEnvironment } from '@listora/db';

export interface DeviceToken {
  token: string;
  environment: PushEnvironment;
}

export interface DeviceDirectory {
  /** The account's device tokens. */
  tokensFor(accountId: string): Promise<DeviceToken[]>;
  /** APNs said the token is no longer valid: no push goes to it again. */
  forget(token: string): Promise<void>;
}

export class PostgresDeviceDirectory implements DeviceDirectory {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async tokensFor(accountId: string): Promise<DeviceToken[]> {
    const rows = await this.#db
      .selectFrom('app_device')
      .select(['push_token', 'push_environment'])
      .where('account_id', '=', accountId)
      .where('push_token', 'is not', null)
      .execute();
    return rows.flatMap((row) =>
      row.push_token === null || row.push_environment === null
        ? []
        : [{ token: row.push_token, environment: row.push_environment }],
    );
  }

  async forget(token: string): Promise<void> {
    await this.#db
      .updateTable('app_device')
      .set({ push_token: null, push_environment: null })
      .where('push_token', '=', token)
      .execute();
  }
}
