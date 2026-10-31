/**
 * The phone runtime's entry in the bundle the iPhone app ships (bundle.ts builds it). The app
 * loads the bundle into a hidden web view of its own and calls `listoraPhone.run(input)` for each
 * call the server hands it; the runtime reaches the app back through the `listora` script
 * message handler, whose every message is answered (`WKScriptMessageHandlerWithReply`).
 *
 * The comparison lane (docs/features/thrift-scan.md, "Marketplace comparisons") runs in the same
 * bundle, in controller pages of its own: `listoraPhone.compare(input)` reads a marketplace's
 * public search for a scanned item and `listoraPhone.warmUp(input)` opens its search page, both
 * on a page that holds no session.
 */
import { isWriteCall } from '../adapter/script-call.ts';
import { runComparison, warmUpComparisons, type WarmUpInput } from '../comps/run.ts';
import { COMPARISON_VERSION, type ComparisonInput } from '../comps/types.ts';
import type { HandOffAnswer, HostPageState, HostPhoto, PhoneHost } from './host.ts';
import {
  PHONE_RUNTIME_VERSION,
  runPhoneCall,
  type PhoneCallInput,
  type PhoneCallOutput,
} from './runtime.ts';

interface MessageHandler {
  postMessage(message: { method: string; args: Record<string, unknown> }): Promise<unknown>;
}

function webkitHost(): PhoneHost {
  const handler = (
    globalThis as unknown as { webkit: { messageHandlers: { listora: MessageHandler } } }
  ).webkit.messageHandlers.listora;
  const call = (method: string, args: Record<string, unknown>): Promise<unknown> =>
    handler.postMessage({ method, args });
  return {
    navigate: async (url, timeoutMs) =>
      (await call('navigate', { url, timeoutMs })) as HostPageState,
    evaluate: (body, args, timeoutMs) => call('evaluate', { body, args, timeoutMs }),
    pageData: async (name, timeoutMs) =>
      (await call('pageData', { name, timeoutMs })) as string | null,
    settle: async (timeoutMs) => (await call('settle', { timeoutMs })) as HostPageState,
    state: async () => (await call('state', {})) as HostPageState,
    acceptNextDialog: async () => {
      await call('acceptNextDialog', {});
    },
    fetchPhoto: async (url, timeoutMs) =>
      (await call('fetchPhoto', { url, timeoutMs })) as HostPhoto,
    handOff: async (check) => (await call('handOff', check)) as HandOffAnswer,
    log: (level, message, fields) => {
      void call('log', { level, message, fields }).catch(() => undefined);
    },
    progress: (step) => {
      void call('progress', { ...step }).catch(() => undefined);
    },
  };
}

/** Runs one call; a failure of the runtime itself is reported as one, never thrown. */
async function run(input: PhoneCallInput): Promise<PhoneCallOutput> {
  try {
    if (input.runtimeVersion !== PHONE_RUNTIME_VERSION) {
      throw new Error(`this app runs calls of version ${String(PHONE_RUNTIME_VERSION)}`);
    }
    return await runPhoneCall(input, webkitHost());
  } catch (thrown) {
    return {
      type: 'ran',
      result: {
        ok: false,
        // A write that failed somewhere unknown may have changed the listing.
        mutated: isWriteCall(input.call),
        steps: [],
        failure: {
          kind: 'error',
          step: 'phone',
          code: 'script_error',
          message: (thrown instanceof Error ? thrown.message : String(thrown)).slice(0, 200),
          retryAfterMs: null,
          screenshotKey: null,
        },
      },
    };
  }
}

/** One comparison read; its output is plain JSON for the app to hand the server. */
async function compare(input: ComparisonInput): Promise<unknown> {
  return JSON.parse(JSON.stringify(await runComparison(input, webkitHost()))) as unknown;
}

async function warmUp(input: WarmUpInput): Promise<unknown> {
  return JSON.parse(JSON.stringify(await warmUpComparisons(input, webkitHost()))) as unknown;
}

(globalThis as Record<string, unknown>)['listoraPhone'] = {
  runtimeVersion: PHONE_RUNTIME_VERSION,
  run,
  comparisonVersion: COMPARISON_VERSION,
  compare,
  warmUp,
};
