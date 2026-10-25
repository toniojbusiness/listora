export { AutomationAdapter } from './adapter/automation-adapter.ts';
export type {
  AutomationAdapterOptions,
  AutomationScripts,
  WriteResult,
  WriteScript,
} from './adapter/automation-adapter.ts';
export { HttpPhotoSource } from './adapter/photos.ts';
export type { PhotoSource } from './adapter/photos.ts';
export { RunnerSessions } from './adapter/runner-sessions.ts';
export type { RunnerSessionsOptions } from './adapter/runner-sessions.ts';
export { NoBrowserSessions } from './adapter/sessions.ts';
export type { AutomationSessions, SessionRequest, SessionRun } from './adapter/sessions.ts';
export { createAutomationAdapters } from './adapters.ts';
export type { AutomationAdapterDependencies } from './adapters.ts';
export {
  AUTOMATION_DISPATCH_SCHEDULE,
  AUTOMATION_DISPATCH_TASK,
  AutomationDispatcher,
  RUN_RETENTION_DAYS,
  RUNNER_TASKS,
  runnerWorkPending,
  runnerWorkWaiting,
} from './dispatch.ts';
export type { DispatcherOptions } from './dispatch.ts';
export { FakeAutomationSite } from './fake-site/fake-site.ts';
export type {
  FakeSiteAction,
  FakeSiteFault,
  FakeSiteFaultRule,
  FakeSiteListing,
  FakeSiteOptions,
  FakeSiteOrder,
  FakeSiteRequest,
} from './fake-site/fake-site.ts';
export { createFakeSiteAdapter } from './fake-site/fake-site-adapter.ts';
export {
  browserRunnerAlive,
  createRunnerLauncher,
  EcsServiceRunnerLauncher,
  loadRunnerLaunchConfig,
  loadRunnerServiceConfig,
  openRunnerPresence,
  ProcessRunnerLauncher,
  RUNNER_SESSION_PREFIX,
  RunnerLaunchConfigError,
  scaleRunnerServiceToZero,
} from './launcher.ts';
export type { LauncherDependencies, RunnerLauncher, RunnerLaunchConfig } from './launcher.ts';
export { linkAutomationSession } from './link.ts';
export type { LinkAutomationInput } from './link.ts';
export {
  AUTOMATED_MARKETPLACES,
  automationProfile,
  DEFAULT_LIMITS,
  DEFAULT_PACING,
  isAutomatedMarketplace,
  LIMITS_CEILING,
  PACING_FLOOR,
  standInProfile,
} from './profiles.ts';
export type {
  AutomatedMarketplace,
  AutomationProfile,
  ChallengeSigns,
  DelayRange,
  PacingSettings,
  RunLimits,
} from './profiles.ts';
export { PlaywrightBrowserRunner } from './runner/browser-runner.ts';
export type { PlaywrightBrowserRunnerOptions } from './runner/browser-runner.ts';
export { DEFAULT_BROWSERS_PATH, loadChromium } from './runner/playwright.ts';
export {
  SCREENSHOT_PREFIX,
  SCREENSHOT_RETENTION_DAYS,
  screenshotKey,
  StorageScreenshotStore,
} from './runner/screenshots.ts';
export type { ScreenshotStore } from './runner/screenshots.ts';
export type {
  AutomationSession,
  BrowserRunner,
  PageDriver,
  Script,
  ScriptErrorCode,
  ScriptFailure,
  ScriptResult,
  SessionSpec,
  StepOptions,
  StepRunner,
  UploadFile,
} from './runner/types.ts';
export { challengeMessage, inspectPage } from './safety/challenges.ts';
export type { PageProblem, PageSignals } from './safety/challenges.ts';
export { Pacing } from './safety/pacing.ts';
export { nextSaleCheckDelay, SALE_HISTORY_DAYS } from './sale-checks/interval.ts';
export { runSaleCheck } from './sale-checks/job.ts';
export type { SaleCheckDependencies } from './sale-checks/job.ts';
export {
  dueSaleChecks,
  enqueueSaleCheck,
  isSaleCheckJobPayload,
  requestSaleCheck,
  SALE_CHECK_TASK,
  saleCheckJobKey,
  scheduleSaleCheck,
} from './sale-checks/schedule.ts';
export type { SaleCheckJobPayload, ScheduledCheck } from './sale-checks/schedule.ts';
export { AutomationConfigError, loadAutomationSettings } from './settings.ts';
export type { AutomationSettings, SaleCheckSettings } from './settings.ts';
