/**
 * The eBay Trading API over HTTP (https://developer.ebay.com/api-docs/user-guides/static/
 * make-a-call/using-xml.html): one XML POST per call to `/ws/api.dll`, named by the
 * `X-EBAY-API-CALL-NAME` header, authorized with the seller's OAuth user token in
 * `X-EBAY-API-IAF-TOKEN`. Every call first takes one call from the daily budget (budget.ts).
 *
 * The client reports what happened without judging it; the adapter maps results onto outcomes
 * (trading-errors.ts). A `Failure` answer means eBay refused the call and applied nothing; a
 * request that may have reached eBay but got no readable answer is `maybe_sent`.
 */
import { requestText } from '../http.ts';
import type { CallPriority, TradingCallBudget } from './budget.ts';
import {
  child,
  children,
  el,
  parseXml,
  text,
  texts,
  toXml,
  TRADING_NAMESPACE,
  XmlParseError,
  type XmlElement,
  type XmlNode,
} from './xml.ts';

/** The Trading API schema version Listora is written against (release notes, 2026-10-06). */
export const TRADING_COMPATIBILITY_LEVEL = '1487';
/** eBay US. */
export const TRADING_SITE_ID = '0';

/** The Trading calls Listora makes. */
export const TRADING_CALLS = [
  'AddFixedPriceItem',
  'VerifyAddFixedPriceItem',
  'ReviseFixedPriceItem',
  'EndFixedPriceItem',
  'RelistFixedPriceItem',
  'GetItem',
  'GetSellerList',
] as const;
export type TradingCallName = (typeof TRADING_CALLS)[number];

/** The `Ack` values of a Trading response (AckCodeType). */
const ACKS: ReadonlySet<string> = new Set(['Success', 'Warning', 'Failure', 'PartialFailure']);

/** One entry of a response's `Errors` container (eBay's `ErrorType`). */
export interface TradingError {
  code: string;
  shortMessage: string;
  longMessage: string;
  /** `Error` (the call failed) or `Warning` (it succeeded with a note). */
  severity: string;
  /** `RequestError` (do not retry as is) or `SystemError` (retrying may work). */
  classification: string;
  /** `ErrorParameters` values, in `ParamID` order. */
  parameters: string[];
}

export type TradingResult =
  /** eBay answered with a Trading response document. */
  | {
      type: 'response';
      /** `Success`, `Warning`, `Failure`, or `PartialFailure`. */
      ack: string;
      /** Only `SeverityCode` Error entries; warnings are in `warnings`. */
      errors: TradingError[];
      warnings: TradingError[];
      body: XmlNode;
    }
  /** An HTTP answer that is not a Trading document (a gateway's 429 or 5xx, say). */
  | { type: 'http_error'; status: number; retryAfterMs?: number }
  /** The daily budget refused the call; nothing was sent. */
  | { type: 'over_budget'; retryAfterMs: number }
  /** The request never left: retrying is safe. */
  | { type: 'not_sent'; code: string }
  /** The request may have reached eBay. */
  | { type: 'maybe_sent'; code: 'timeout' | 'aborted' | 'connection_lost' };

export interface TradingClientOptions {
  /** `https://api.ebay.com/ws/api.dll`, the sandbox's, or the fake's. */
  url: string;
  budget: TradingCallBudget;
  timeoutMs?: number;
}

export interface TradingCallOptions {
  token: string;
  priority: CallPriority;
  signal: AbortSignal;
}

export class TradingClient {
  readonly #options: TradingClientOptions;

  constructor(options: TradingClientOptions) {
    this.#options = options;
  }

  async call(
    callName: TradingCallName,
    fields: readonly (XmlElement | null | undefined)[],
    options: TradingCallOptions,
  ): Promise<TradingResult> {
    const admitted = await this.#options.budget.take(options.priority, options.signal);
    if (!admitted.ok) return { type: 'over_budget', retryAfterMs: admitted.retryAfterMs };

    const document = toXml(
      el(
        `${callName}Request`,
        [el('ErrorLanguage', 'en_US'), el('WarningLevel', 'High'), ...fields],
        {
          xmlns: TRADING_NAMESPACE,
        },
      ),
    );
    const result = await requestText({
      method: 'POST',
      url: this.#options.url,
      headers: {
        'content-type': 'text/xml',
        'x-ebay-api-call-name': callName,
        'x-ebay-api-siteid': TRADING_SITE_ID,
        'x-ebay-api-compatibility-level': TRADING_COMPATIBILITY_LEVEL,
        'x-ebay-api-iaf-token': options.token,
      },
      body: document,
      signal: options.signal,
      timeoutMs: this.#options.timeoutMs ?? 20_000,
    });
    if (result.type !== 'response') return result;
    if (result.status !== 200) {
      const retryAfter = Number(result.headers.get('retry-after'));
      return {
        type: 'http_error',
        status: result.status,
        ...(Number.isFinite(retryAfter) && retryAfter > 0
          ? { retryAfterMs: retryAfter * 1000 }
          : {}),
      };
    }
    let parsed: { name: string; node: XmlNode };
    try {
      parsed = parseXml(result.text);
    } catch (error) {
      if (!(error instanceof XmlParseError)) throw error;
      // A 200 without a readable answer: eBay may have applied the call.
      return { type: 'maybe_sent', code: 'connection_lost' };
    }
    if (parsed.name !== `${callName}Response`) {
      return { type: 'maybe_sent', code: 'connection_lost' };
    }
    const ack = text(parsed.node, 'Ack') ?? '';
    // Without a known Ack the answer is unreadable (a truncated body, say): eBay may have
    // applied the call.
    if (!ACKS.has(ack)) return { type: 'maybe_sent', code: 'connection_lost' };
    const all = children(parsed.node, 'Errors').map(readError);
    return {
      type: 'response',
      ack,
      errors: all.filter((error) => error.severity !== 'Warning'),
      warnings: all.filter((error) => error.severity === 'Warning'),
      body: parsed.node,
    };
  }
}

function readError(node: XmlNode): TradingError {
  return {
    code: text(node, 'ErrorCode') ?? '',
    shortMessage: text(node, 'ShortMessage') ?? '',
    longMessage: text(node, 'LongMessage') ?? '',
    severity: text(node, 'SeverityCode') ?? 'Error',
    classification: text(node, 'ErrorClassification') ?? '',
    parameters: children(node, 'ErrorParameters').flatMap((parameter) => texts(parameter, 'Value')),
  };
}

/** Whether a Trading answer means the call succeeded (possibly with warnings). */
export function succeeded(result: Extract<TradingResult, { type: 'response' }>): boolean {
  return (result.ack === 'Success' || result.ack === 'Warning') && result.errors.length === 0;
}

/** `Item` of a GetItem response. */
export function itemOf(body: XmlNode): XmlNode | undefined {
  return child(body, 'Item');
}
