import { inTransaction, type AiControlAction, type DbExecutor } from '@listora/db';

import type { AiControls } from './guards.ts';

/** Who changed a control and why; both are kept in the audit trail. */
export interface AiControlChange {
  /** The operator, for example a login name. */
  readonly actor: string;
  readonly reason: string;
}

export interface KillSwitchState {
  readonly engaged: boolean;
  /** The last change; null until the switch has been changed once. */
  readonly lastChange: (AiControlChange & { readonly at: Date }) | null;
}

export interface AccountBlock {
  readonly accountId: string;
  readonly accountName: string;
  readonly blockedBy: string;
  readonly reason: string;
  readonly blockedAt: Date;
}

export interface AiControlAuditEntry {
  readonly id: string;
  readonly action: AiControlAction;
  /** Null for the kill switch. */
  readonly accountId: string | null;
  readonly actor: string;
  readonly reason: string;
  readonly createdAt: Date;
}

/** A control change was refused: bad input or an unknown account. Nothing was changed. */
export class AiControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiControlError';
  }
}

const MAX_ACTOR_LENGTH = 200;
const MAX_REASON_LENGTH = 500;

/**
 * The operator-managed AI controls, stored in Postgres: the global kill switch and per-account
 * blocks. `AiClient` asks `isEngaged` and `isBlocked` on every call, so a change takes effect
 * on the next call in every process. Each change writes its `ai_control_audit` row in the
 * same transaction, and a request that would not change anything (turning on a switch that
 * is already on) writes nothing and returns `changed: false`.
 */
export class PostgresAiControls implements AiControls {
  readonly #db: DbExecutor;

  constructor(db: DbExecutor) {
    this.#db = db;
  }

  async isEngaged(): Promise<boolean> {
    return (await this.killSwitch()).engaged;
  }

  async isBlocked(accountId: string): Promise<boolean> {
    const row = await this.#db
      .selectFrom('ai_account_block')
      .select('account_id')
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async killSwitch(): Promise<KillSwitchState> {
    const row = await this.#db
      .selectFrom('ai_kill_switch')
      .select(['engaged', 'changed_by', 'reason', 'updated_at'])
      .executeTakeFirstOrThrow();
    return {
      engaged: row.engaged,
      lastChange:
        row.changed_by === null || row.reason === null
          ? null
          : { actor: row.changed_by, reason: row.reason, at: row.updated_at },
    };
  }

  /** Turns the global kill switch on or off. */
  async setKillSwitch(engaged: boolean, change: AiControlChange): Promise<{ changed: boolean }> {
    const { actor, reason } = validChange(change);
    return inTransaction(this.#db, async (trx) => {
      // The row lock serializes concurrent changes, so each one is audited exactly once.
      const current = await trx
        .selectFrom('ai_kill_switch')
        .select('engaged')
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.engaged === engaged) return { changed: false };
      await trx.updateTable('ai_kill_switch').set({ engaged, changed_by: actor, reason }).execute();
      await trx
        .insertInto('ai_control_audit')
        .values({ action: engaged ? 'kill_switch_on' : 'kill_switch_off', actor, reason })
        .execute();
      return { changed: true };
    });
  }

  /** Blocks the account from AI until it is unblocked. */
  async blockAccount(accountId: string, change: AiControlChange): Promise<{ changed: boolean }> {
    const { actor, reason } = validChange(change);
    return inTransaction(this.#db, async (trx) => {
      const account = await trx
        .selectFrom('account')
        .select('id')
        .where('id', '=', accountId)
        .forShare()
        .executeTakeFirst();
      if (account === undefined) throw new AiControlError(`no account ${accountId}`);
      const inserted = await trx
        .insertInto('ai_account_block')
        .values({ account_id: accountId, blocked_by: actor, reason })
        .onConflict((conflict) => conflict.column('account_id').doNothing())
        .returning('account_id')
        .executeTakeFirst();
      if (inserted === undefined) return { changed: false };
      await trx
        .insertInto('ai_control_audit')
        .values({ action: 'account_block_on', account_id: accountId, actor, reason })
        .execute();
      return { changed: true };
    });
  }

  /** Lifts the account's block. */
  async unblockAccount(accountId: string, change: AiControlChange): Promise<{ changed: boolean }> {
    const { actor, reason } = validChange(change);
    return inTransaction(this.#db, async (trx) => {
      const deleted = await trx
        .deleteFrom('ai_account_block')
        .where('account_id', '=', accountId)
        .returning('account_id')
        .executeTakeFirst();
      if (deleted === undefined) {
        const account = await trx
          .selectFrom('account')
          .select('id')
          .where('id', '=', accountId)
          .executeTakeFirst();
        if (account === undefined) throw new AiControlError(`no account ${accountId}`);
        return { changed: false };
      }
      await trx
        .insertInto('ai_control_audit')
        .values({ action: 'account_block_off', account_id: accountId, actor, reason })
        .execute();
      return { changed: true };
    });
  }

  /** Every blocked account, oldest block first. */
  async blockedAccounts(): Promise<AccountBlock[]> {
    const rows = await this.#db
      .selectFrom('ai_account_block as block')
      .innerJoin('account', 'account.id', 'block.account_id')
      .select([
        'block.account_id as accountId',
        'account.name as accountName',
        'block.blocked_by as blockedBy',
        'block.reason as reason',
        'block.created_at as blockedAt',
      ])
      .orderBy('block.created_at')
      .orderBy('block.account_id')
      .execute();
    return rows;
  }

  /** The audit trail, newest first, optionally for one account only. */
  async auditTrail(
    options: { readonly accountId?: string; readonly limit?: number } = {},
  ): Promise<AiControlAuditEntry[]> {
    let query = this.#db
      .selectFrom('ai_control_audit')
      .select([
        'id',
        'action',
        'account_id as accountId',
        'actor',
        'reason',
        'created_at as createdAt',
      ])
      // uuidv7 ids increase with time, so they order rows written in the same instant.
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(options.limit ?? 50);
    if (options.accountId !== undefined) query = query.where('account_id', '=', options.accountId);
    return query.execute();
  }
}

function validChange(change: AiControlChange): AiControlChange {
  const actor = change.actor.trim();
  const reason = change.reason.trim();
  if (actor === '' || actor.length > MAX_ACTOR_LENGTH) {
    throw new AiControlError(`actor must be 1 to ${String(MAX_ACTOR_LENGTH)} characters`);
  }
  if (reason === '' || reason.length > MAX_REASON_LENGTH) {
    throw new AiControlError(`reason must be 1 to ${String(MAX_REASON_LENGTH)} characters`);
  }
  return { actor, reason };
}
