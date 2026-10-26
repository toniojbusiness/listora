/**
 * Where forwarded mail comes from, behind one interface: the folder driver in development and
 * tests (drivers/folder.ts) and SES receiving in AWS (drivers/ses.ts). The worker's ingest job
 * reads each waiting message, processes it, and only then calls `done`, which deletes the raw
 * message: a message whose processing failed (the database was down) waits and is read again.
 */
import type { MailAuthentication } from '../authentication.ts';
import type { MailMessage } from '../message.ts';

export interface ReceivedMail {
  /** For logs only: the file's or the queue message's id. */
  id: string;
  raw: Uint8Array;
  /**
   * The addresses the receiver delivered it to (SES's envelope recipients), or null when only
   * the message's own delivery headers say (`Delivered-To`, `X-Original-To`, `To`).
   */
  envelopeRecipients: readonly string[] | null;
  /** The receiver's verdicts on the message (authentication.ts). */
  authenticate(message: MailMessage): MailAuthentication;
  /** Deletes the raw message once it is processed, whatever the outcome. */
  done(): Promise<void>;
}

export interface MailSource {
  /** Up to `max` waiting messages, oldest first where the source knows the order. */
  receive(max: number): Promise<ReceivedMail[]>;
}
