/**
 * What the phone conformance suites share: one file per marketplace,
 * conformance-<marketplace>.int.test.ts, so they run side by side. Each runs the phone runtime
 * (docs/features/phone-execution.md) against the shared adapter conformance suite: the adapter's
 * sessions are served by the phone's own code (runtime, page backend, page functions, and the
 * bundled marketplace scripts) in headless Chromium standing in for the iPhone app's web view, on
 * that marketplace's fake site. So the phone creates, edits, reprices, ends, relists, reads back,
 * and checks health exactly as the browser runner does, and maps every failure the same way. The
 * app's own web view is tested on the simulator against the local stack (PhoneExecutionUITests).
 */
import { automationProfile, standInProfile, type AutomatedMarketplace } from '../profiles.ts';
import { QUICK_PACING, type SessionIssuer } from '../test-support.ts';
import { PhoneTestSessions } from './test-host.ts';

export interface FakeSite extends SessionIssuer {
  url: string;
  close(): Promise<void>;
}

/** A started fake site, and the URL of one that no longer answers. */
export async function sites<T extends FakeSite>(start: () => Promise<T>): Promise<[T, string]> {
  const site = await start();
  const closed = await start();
  const unreachable = closed.url;
  await closed.close();
  return [site, unreachable];
}

export function phoneSessions(
  site: SessionIssuer,
  marketplace: AutomatedMarketplace,
  siteUrl: string,
  stepTimeoutMs: number,
): PhoneTestSessions {
  const profile = {
    ...standInProfile(automationProfile(marketplace), siteUrl),
    pacing: QUICK_PACING,
  };
  return new PhoneTestSessions(site, profile, stepTimeoutMs);
}

/** Each suite's phone sessions, closed with its site when the suite ends. */
export function suiteSessions(site: FakeSite) {
  const opened: PhoneTestSessions[] = [];
  const track = (sessions: PhoneTestSessions): PhoneTestSessions => {
    opened.push(sessions);
    return sessions;
  };
  const teardown = async (): Promise<void> => {
    for (const sessions of opened) await sessions.close();
    await site.close();
  };
  return { track, teardown };
}
