import { describe, expect, it } from 'vitest';

import { ownTaskJobFetch } from './job-fetch.ts';

/** The shape of Graphile Worker 0.18's job fetch (getJobs.ts, batch size 1, no flags). */
const FETCH = `\
with j as (
  select jobs.job_queue_id, jobs.priority, jobs.run_at, jobs.id
    from "graphile_worker"._private_jobs as jobs
    where jobs.is_available = true
    and run_at <= now()
    and task_id = any($2::int[])
    and (
      jobs.job_queue_id is null
      or
      jobs.job_queue_id in (
        select id
        from "graphile_worker"._private_job_queues as job_queues
        where job_queues.is_available = true
        for update
        skip locked
      )
    )
    order by priority asc, run_at asc
    limit 1
    for update
    skip locked
)`;

describe('ownTaskJobFetch', () => {
  it("asks for the runner's task before it looks at, and locks, a job's queue", () => {
    const fetch = ownTaskJobFetch(FETCH);
    expect(fetch).toContain(
      '      or\n      jobs.task_id = any($2::int[]) and jobs.job_queue_id in (\n        select id',
    );
    expect(fetch.replace('jobs.task_id = any($2::int[]) and ', '')).toBe(FETCH);
  });

  it('leaves every other query as it is', () => {
    const complete =
      'with j as (delete from "graphile_worker"._private_jobs where id = $1) select 1';
    expect(ownTaskJobFetch(complete)).toBe(complete);
    expect(ownTaskJobFetch('select 1')).toBe('select 1');
  });

  it('refuses a fetch whose queue term changed, rather than running it unchanged', () => {
    const changed = FETCH.replace('jobs.job_queue_id in (', 'exists (');
    expect(() => ownTaskJobFetch(changed)).toThrow("Graphile Worker's job fetch changed");
  });
});
