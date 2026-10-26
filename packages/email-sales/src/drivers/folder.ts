/**
 * The folder driver (`EMAIL_INGEST=folder`, development and tests): every `.eml` file in the
 * inbox folder is a received message, read in name order and deleted once processed. The API's
 * `POST /dev/email` drops a posted message there (`dropInInbox`), and a developer can copy a
 * file in by hand.
 *
 * A dropped file plays the receiving server's part itself: its first `Authentication-Results`
 * header from `mx.listora.test` holds the SPF and DKIM verdicts (as SES's header does in AWS),
 * and its `Delivered-To` header the forwarding address. A file without them proves nothing and
 * is rejected like a spoofed email.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { authenticationFromHeaders } from '../authentication.ts';
import { MAX_MESSAGE_BYTES } from '../message.ts';
import type { MailSource, ReceivedMail } from './source.ts';

/** The receiver a dropped file's `Authentication-Results` header must name. */
export const DEV_RECEIVER = 'mx.listora.test';

export class FolderMailSource implements MailSource {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async receive(max: number): Promise<ReceivedMail[]> {
    await mkdir(this.#dir, { recursive: true });
    const names = (await readdir(this.#dir)).filter((name) => name.endsWith('.eml')).sort();
    const mail: ReceivedMail[] = [];
    for (const name of names.slice(0, max)) {
      const path = join(this.#dir, name);
      let raw: Buffer;
      try {
        raw = await readFile(path);
      } catch (error) {
        // Taken by another worker meanwhile.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      mail.push({
        id: name,
        raw,
        envelopeRecipients: null,
        authenticate: (message) => authenticationFromHeaders(message, DEV_RECEIVER),
        done: async () => {
          await unlink(path).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          });
        },
      });
    }
    return mail;
  }
}

/** Puts a raw message in the inbox folder, whole or not at all; returns its file name. */
export async function dropInInbox(dir: string, raw: Uint8Array): Promise<string> {
  if (raw.byteLength > MAX_MESSAGE_BYTES) throw new RangeError('the message is too large');
  await mkdir(dir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.eml`;
  const partial = join(dir, `.${name}.partial`);
  await writeFile(partial, raw);
  await rename(partial, join(dir, name));
  return name;
}
