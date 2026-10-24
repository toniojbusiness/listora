/**
 * Recovering the jobs of a worker that died mid-step.
 *
 * Graphile Worker locks a running job (and its listing queue) with the worker pool's id and,
 * by itself, only releases the locks of a pool that vanished after four hours. That would stall
 * a listing for hours after a crash, so every Listora worker proves it is alive with one
 * Postgres session whose `application_name` is `listora-worker:<pool id>`. The operating system
 * closes that session when the process dies, even on SIGKILL. Each live worker periodically
 * releases locks held by pools that have no such session (`reapStoppedWorkers`); the released
 * job then runs again, finds its operation `running`, and reads the listing back instead of
 * sending again (executor.ts).
 *
 * Requirements: every process that runs Graphile Worker jobs on this database must be started
 * through `startOperationWorker`, all workers use the same database role (so they can see each
 * other's sessions), and the liveness session must be a direct connection, not one shared
 * through a transaction pooler.
 */
import { sql } from 'kysely';
import pg from 'pg';

import type { Db } from '@listora/db';

export const LIVENESS_APPLICATION_PREFIX = 'listora-worker:';

/**
 * The session that shows this worker is alive. If it is lost, the worker can no longer prove
 * it is alive and other workers will take over its jobs, so it must stop at once.
 */
export class WorkerLiveness {
  readonly #client: pg.Client;
  #closing = false;

  private constructor(client: pg.Client) {
    this.#client = client;
  }

  static async open(
    connectionString: string,
    onLost: (error: Error) => void,
  ): Promise<WorkerLiveness> {
    const client = new pg.Client({
      connectionString,
      application_name: `${LIVENESS_APPLICATION_PREFIX}starting`,
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    const liveness = new WorkerLiveness(client);
    client.on('error', (error) => {
      if (!liveness.#closing) onLost(error);
    });
    client.on('end', () => {
      if (!liveness.#closing) onLost(new Error('the worker liveness session ended'));
    });
    await client.connect();
    // Let the server notice a vanished worker host within about a minute, not hours.
    await client.query(
      'set tcp_keepalives_idle = 30; set tcp_keepalives_interval = 10; set tcp_keepalives_count = 3',
    );
    return liveness;
  }

  /** Publishes the pool id that this worker's job locks carry. */
  async register(poolId: string): Promise<void> {
    await this.#client.query("select set_config('application_name', $1, false)", [
      `${LIVENESS_APPLICATION_PREFIX}${poolId}`,
    ]);
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#client.end();
  }
}

/**
 * Releases the job and queue locks of worker pools that have no liveness session. Locks newer
 * than `graceMs` are left alone, which covers a starting worker that has not published its pool
 * id yet. Returns the pool ids released.
 */
export async function reapStoppedWorkers(db: Db, graceMs: number): Promise<string[]> {
  const { rows } = await sql<{ locked_by: string }>`
    select distinct jobs.locked_by
    from graphile_worker.jobs as jobs
    where jobs.locked_by is not null
      and jobs.locked_at < now() - make_interval(secs => ${graceMs / 1000})
      and not exists (
        select 1 from pg_stat_activity as activity
        where activity.application_name = ${LIVENESS_APPLICATION_PREFIX} || jobs.locked_by
      )
  `.execute(db);
  const poolIds = rows.map((row) => row.locked_by);
  if (poolIds.length > 0) {
    await sql`select graphile_worker.force_unlock_workers(${poolIds}::text[])`.execute(db);
  }
  return poolIds;
}
