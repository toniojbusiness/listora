export interface AnalysisConfig {
  /** `AI_AUTO_ESCALATE`: run the premium identification when a standard analysis asks for it. */
  readonly autoEscalate: boolean;
}

export class AnalysisConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid analysis configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'AnalysisConfigError';
    this.issues = issues;
  }
}

/** Reads the analysis settings from the environment (see `.env.example`), once at startup. */
export function loadAnalysisConfig(env: NodeJS.ProcessEnv = process.env): AnalysisConfig {
  const autoEscalate = env['AI_AUTO_ESCALATE'] ?? 'on';
  if (autoEscalate !== 'on' && autoEscalate !== 'off') {
    throw new AnalysisConfigError(['AI_AUTO_ESCALATE must be on or off']);
  }
  return { autoEscalate: autoEscalate === 'on' };
}
