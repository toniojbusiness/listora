/**
 * Job discovery. Each file in `features/` exports `feature: WorkerFeature`: the jobs one
 * feature runs besides operation steps (the engine's own). The worker registers every feature
 * it finds, so a new feature adds its own file and never edits a shared list.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AiClient } from '@listora/ai';
import type { Db } from '@listora/db';
import type { ScheduledTask, WorkerTask } from '@listora/operations';
import type { Logger } from '@listora/shared';
import type { ObjectStorage } from '@listora/storage';

import type { WorkerConfig } from './config.ts';

/** Everything a feature's jobs may use, built once by main.ts. */
export interface WorkerContext {
  config: WorkerConfig;
  db: Db;
  /** Photo storage, the same one the API uses. */
  storage: ObjectStorage;
  /** The AI client, with the guards, metering, and quotas of `config.ai`. */
  ai: AiClient;
  logger: Logger;
}

export interface WorkerJobs {
  /** Jobs by task name, run in the worker's task pool. */
  tasks?: Record<string, WorkerTask>;
  /** Recurring jobs, also in the task pool. */
  scheduledTasks?: readonly ScheduledTask[];
  /** Graphile crontab lines that schedule this feature's `tasks` (one job per tick). */
  crontab?: readonly string[];
}

/** What a file in `features/` exports as `feature`. */
export interface WorkerFeature {
  jobs: (context: WorkerContext) => WorkerJobs;
}

export interface DiscoveredWorkerFeature {
  /** The feature's file name in `features/`, without `.ts`. */
  name: string;
  feature: WorkerFeature;
}

/**
 * Imports every module of `featuresDir` (tests excluded), in file name order. A module
 * without a `WorkerFeature` export is an error, so a feature can never be skipped silently.
 */
export async function discoverWorkerFeatures(
  featuresDir: string = join(import.meta.dirname, 'features'),
): Promise<DiscoveredWorkerFeature[]> {
  const files = readdirSync(featuresDir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .sort();
  const features: DiscoveredWorkerFeature[] = [];
  for (const file of files) {
    const path = join(featuresDir, file);
    const module = (await import(pathToFileURL(path).href)) as { feature?: Partial<WorkerFeature> };
    if (typeof module.feature?.jobs !== 'function') {
      throw new Error(`${path} must export \`feature\`, a WorkerFeature with jobs`);
    }
    features.push({ name: file.slice(0, -'.ts'.length), feature: module.feature as WorkerFeature });
  }
  return features;
}

/** Every feature's jobs, merged; two features with one task name are an error. */
export function collectWorkerJobs(
  features: readonly DiscoveredWorkerFeature[],
  context: WorkerContext,
): { tasks: Record<string, WorkerTask>; scheduledTasks: ScheduledTask[]; crontab: string[] } {
  const owners = new Map<string, string>();
  const tasks: Record<string, WorkerTask> = {};
  const scheduledTasks: ScheduledTask[] = [];
  const crontab: string[] = [];
  const claim = (task: string, feature: string): void => {
    const owner = owners.get(task);
    if (owner !== undefined) {
      throw new Error(`Worker features ${owner} and ${feature} both define the task ${task}`);
    }
    owners.set(task, feature);
  };
  for (const { name, feature } of features) {
    const jobs = feature.jobs(context);
    for (const [task, run] of Object.entries(jobs.tasks ?? {})) {
      claim(task, name);
      tasks[task] = run;
    }
    for (const scheduled of jobs.scheduledTasks ?? []) {
      claim(scheduled.name, name);
      scheduledTasks.push(scheduled);
    }
    crontab.push(...(jobs.crontab ?? []));
  }
  return { tasks, scheduledTasks, crontab };
}

/** The features of this worker, found once when the module loads. */
export const WORKER_FEATURES: readonly DiscoveredWorkerFeature[] = await discoverWorkerFeatures();
