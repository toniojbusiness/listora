/**
 * HTTP helpers the fake marketplace sites share (test and development only): replies, form
 * parsing (URL-encoded and multipart, with photo uploads), cookies, and HTML escaping.
 */
import type { IncomingMessage } from 'node:http';

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export function redirect(location: string): Reply {
  return { status: 303, headers: { location } };
}

/** A submitted form: its text fields, and how many bytes each file field brought. */
export interface SubmittedForm {
  text(name: string): string;
  /** The sizes of the non-empty files sent in `name`. */
  files(name: string): number[];
}

export async function readForm(request: IncomingMessage): Promise<SubmittedForm> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const type = request.headers['content-type'] ?? '';
  const boundary = /^multipart\/form-data;.*boundary=("?)([^";]+)\1/i.exec(type)?.[2];
  const fields = new Map<string, string>();
  const files = new Map<string, number[]>();
  if (boundary === undefined) {
    for (const [name, value] of new URLSearchParams(body.toString('utf8'))) fields.set(name, value);
  } else {
    // The parts between the boundary lines: headers, a blank line, then the content.
    const delimiter = Buffer.from(`--${boundary}`);
    let start = body.indexOf(delimiter);
    while (start !== -1) {
      const next = body.indexOf(delimiter, start + delimiter.length);
      if (next === -1) break;
      const part = body.subarray(start + delimiter.length + 2, next - 2);
      const split = part.indexOf('\r\n\r\n');
      if (split !== -1) {
        const headers = part.subarray(0, split).toString('utf8');
        const content = part.subarray(split + 4);
        const name = /name="([^"]*)"/.exec(headers)?.[1];
        if (name !== undefined) {
          if (headers.includes('filename="')) {
            if (content.length > 0) files.set(name, [...(files.get(name) ?? []), content.length]);
          } else {
            fields.set(name, content.toString('utf8'));
          }
        }
      }
      start = next;
    }
  }
  return {
    text: (name) => fields.get(name)?.trim() ?? '',
    files: (name) => files.get(name) ?? [],
  };
}

export function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/** Waits `ms`, tracked in `timers` so a closing site can cancel it. */
export function delay(ms: number, timers: Set<NodeJS.Timeout>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      resolve();
    }, ms);
    timers.add(timer);
  });
}
