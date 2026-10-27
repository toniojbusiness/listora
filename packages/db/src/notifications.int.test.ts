import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listenForNotifications, type NotificationListener } from './notifications.ts';
import { createMigratedDatabase, type MigratedDatabase } from './test-support.ts';

describe('listenForNotifications', () => {
  let database: MigratedDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('notify');
  });

  afterAll(async () => {
    await database.close();
  });

  async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function listen(heard: string[], states: boolean[] = []): NotificationListener {
    return listenForNotifications({
      connectionString: database.scratch.url,
      channel: 'listora_test',
      onNotification: (payload) => heard.push(payload),
      onListening: (listening) => states.push(listening),
      retryMs: 20,
    });
  }

  it('hears a notification when its transaction commits, and never one rolled back', async () => {
    const heard: string[] = [];
    const listener = listen(heard);
    try {
      await until(() => listener.listening);
      await database.db.transaction().execute(async (trx) => {
        await sql`select pg_notify('listora_test', 'first')`.execute(trx);
        await new Promise((resolve) => setTimeout(resolve, 50));
        // Not before the commit.
        expect(heard).toEqual([]);
      });
      await database.db
        .transaction()
        .execute(async (trx) => {
          await sql`select pg_notify('listora_test', 'rolled back')`.execute(trx);
          throw new Error('roll back');
        })
        .catch(() => undefined);
      await sql`select pg_notify('other_channel', 'elsewhere')`.execute(database.db);
      await sql`select pg_notify('listora_test', 'second')`.execute(database.db);
      await until(() => heard.length === 2);
      expect(heard).toEqual(['first', 'second']);
    } finally {
      await listener.close();
    }
    expect(listener.listening).toBe(false);
  });

  it('listens again after its connection is cut', async () => {
    const heard: string[] = [];
    const states: boolean[] = [];
    const listener = listen(heard, states);
    try {
      await until(() => listener.listening);
      await sql`
        select pg_terminate_backend(pid) from pg_stat_activity
        where datname = current_database() and query = 'listen listora_test'
      `.execute(database.db);
      await until(() => states.length >= 3 && listener.listening);
      expect(states.slice(0, 3)).toEqual([true, false, true]);
      await sql`select pg_notify('listora_test', 'after')`.execute(database.db);
      await until(() => heard.includes('after'));
    } finally {
      await listener.close();
    }
  });

  it('refuses a channel that is not a plain name', () => {
    expect(() =>
      listenForNotifications({
        connectionString: database.scratch.url,
        channel: 'x; drop table account',
        onNotification: () => undefined,
      }),
    ).toThrow('is not a channel name');
  });
});
