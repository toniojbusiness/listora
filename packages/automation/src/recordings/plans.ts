/** Every marketplace's recording plan (plan.ts). */
import { depopRecordingPlan } from '../depop/recording-plan.ts';
import { mercariRecordingPlan } from '../mercari/recording-plan.ts';
import { poshmarkRecordingPlan } from '../poshmark/recording-plan.ts';
import type { RecordingPlan } from './plan.ts';
import type { RecordedMarketplace } from './recording.ts';

export function recordingPlan(marketplace: RecordedMarketplace): RecordingPlan {
  switch (marketplace) {
    case 'depop':
      return depopRecordingPlan;
    case 'mercari':
      return mercariRecordingPlan;
    case 'poshmark':
      return poshmarkRecordingPlan;
  }
}
