/**
 * Where a run on the phone is, in the words the app shows while it works
 * (docs/features/phone-execution.md): each step as it starts, its number in the run, and what it
 * does in plain words ("Adding the photos", "Choosing the category", "Posting").
 */

/** A step the run started (`PhoneHost.progress`). */
export interface PhoneStep {
  /** The call's name (`create`, `read listing`): the app keeps step timings per call. */
  call: string;
  /** The step's number in the run, from 1. */
  index: number;
  /** What the step does, in plain words. */
  label: string;
}

/** Short verbs whose last letter doubles before "-ing" ("set", "setting"). */
const DOUBLED = new Set(['get', 'set', 'put', 'cut', 'run', 'stop', 'drop', 'tap', 'pin', 'shop']);

/**
 * A step's name ("add the photos", scripts name each step with an imperative) as what is happening
 * ("Adding the photos").
 */
export function stepLabel(name: string): string {
  const [verb = '', ...rest] = name.trim().split(/\s+/);
  const lower = verb.toLowerCase();
  if (!/^[a-z]+$/.test(lower)) return name;
  const doing = DOUBLED.has(lower)
    ? `${lower}${lower.slice(-1)}ing`
    : lower.endsWith('e') && !lower.endsWith('ee')
      ? `${lower.slice(0, -1)}ing`
      : `${lower}ing`;
  return [`${doing.charAt(0).toUpperCase()}${doing.slice(1)}`, ...rest].join(' ');
}
