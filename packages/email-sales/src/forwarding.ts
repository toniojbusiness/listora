/**
 * The email provider's forwarding confirmation. Gmail (and some others) ask the owner of the
 * forwarding address to confirm before they forward anything: they send a code and a link to
 * the address itself, which is Listora's. Listora shows them to the seller, who types the code
 * into their provider's settings or opens the link; Listora never opens the link itself.
 *
 * Only a confirmation whose sender is verified (DKIM and SPF, authentication.ts) is shown, and
 * only a link on the provider's own domain, so a forged confirmation cannot put a link of its
 * choosing in front of the seller.
 */
import { isWithinDomain } from './authentication.ts';
import type { MailMessage } from './message.ts';

export interface ForwardingConfirmation {
  /** The provider's name, such as "Gmail". */
  provider: string;
  code: string | null;
  url: string | null;
}

const CODE_IN_SUBJECT = /\(#(\d{6,12})\)/;
const CODE_IN_TEXT = /confirmation code\s*:?\s*(\d{6,12})\b/i;

/** The confirmation in a provider's message, or null when the message is not one. */
export function readForwardingConfirmation(
  provider: { name: string; domain: string },
  message: MailMessage,
): ForwardingConfirmation | null {
  const words = `${message.subject}\n${message.text}`;
  if (!/forward/i.test(words) || !/(confirm|verif)/i.test(words)) return null;
  const code =
    CODE_IN_SUBJECT.exec(message.subject)?.[1] ?? CODE_IN_TEXT.exec(message.text)?.[1] ?? null;
  const url =
    message.links.find((link) => {
      if (link.length > 2048) return false;
      try {
        const parsed = new URL(link);
        return parsed.protocol === 'https:' && isWithinDomain(parsed.hostname, provider.domain);
      } catch {
        return false;
      }
    }) ?? null;
  if (code === null && url === null) return null;
  return { provider: provider.name, code, url };
}
