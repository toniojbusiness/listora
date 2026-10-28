/**
 * Owner alerts the application sends itself (docs/features/read-health.md), as opposed to the
 * alarm topic's: the worker emails the owner through the same SES sender and recipient as the
 * alert function, or, in development and tests, only logs the email.
 */

/** How the worker's owner alerts are delivered (`OWNER_ALERTS`). */
export type OwnerAlertDelivery =
  | { readonly driver: 'log' }
  | { readonly driver: 'ses'; readonly from: string; readonly to: string };

export interface OwnerAlertConfig {
  /** The subject's tag, `[Listora <environment>]`, as on the alarm emails. */
  readonly environment: string;
  readonly delivery: OwnerAlertDelivery;
}

export class OwnerAlertConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid owner alert configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'OwnerAlertConfigError';
    this.issues = issues;
  }
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENVIRONMENT = /^[a-z0-9-]{1,20}$/;

/**
 * Reads `OWNER_ALERTS` (`log`, the default, or `ses`), `OWNER_ALERT_ENV`, and for SES
 * `OWNER_ALERT_FROM` and `OWNER_ALERT_TO`. Errors name the bad key, never its value.
 */
export function loadOwnerAlertConfig(env: NodeJS.ProcessEnv = process.env): OwnerAlertConfig {
  const issues: string[] = [];
  const value = (key: string): string | undefined => {
    const raw = env[key];
    return raw === undefined || raw === '' ? undefined : raw;
  };
  const environment = value('OWNER_ALERT_ENV') ?? 'local';
  if (!ENVIRONMENT.test(environment)) {
    issues.push('OWNER_ALERT_ENV must be 1 to 20 lowercase letters, digits, or dashes');
  }
  const driver = value('OWNER_ALERTS') ?? 'log';
  let delivery: OwnerAlertDelivery = { driver: 'log' };
  if (driver === 'ses') {
    const address = (key: string): string => {
      const found = value(key);
      if (found === undefined) issues.push(`${key} is required when OWNER_ALERTS is ses`);
      else if (!ADDRESS.test(found)) issues.push(`${key} must be an email address`);
      return found ?? '';
    };
    delivery = { driver: 'ses', from: address('OWNER_ALERT_FROM'), to: address('OWNER_ALERT_TO') };
  } else if (driver !== 'log') {
    issues.push('OWNER_ALERTS must be log or ses');
  }
  if (issues.length > 0) throw new OwnerAlertConfigError(issues);
  return { environment, delivery };
}
