import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import { ApiError, validationFailed } from '../errors.ts';
import type { AuthDriver, Identity } from './driver.ts';

const ISSUER = 'listora-dev-auth';
const AUDIENCE = 'listora-api';
const CODE_DIGITS = 6;

export interface DevAuthOptions {
  /** HMAC-SHA256 key for session tokens (AUTH_DEV_SECRET, or random per process). */
  secret: string;
  logger: FastifyBaseLogger;
  /** Milliseconds since the epoch; injectable so tests can expire codes and sessions. */
  now?: () => number;
  codeTtlSeconds?: number;
  sessionTtlSeconds?: number;
  /** Wrong guesses allowed per code before it is discarded. */
  maxAttempts?: number;
  /** Outstanding codes kept at once; more requests are refused until some expire. */
  maxPendingCodes?: number;
  /**
   * Wrong guesses allowed per email, and across all emails, within `guessWindowSeconds`. A new
   * code does not reset them, so asking for code after code cannot brute-force the 6 digits.
   */
  maxWrongGuessesPerEmail?: number;
  maxWrongGuesses?: number;
  guessWindowSeconds?: number;
}

export interface DevSession {
  accessToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
}

interface PendingCode {
  codeHash: Buffer;
  expiresAt: number;
  attemptsLeft: number;
}

/**
 * Local sign-in for development (`AUTH_DRIVER=dev`, see docs/architecture.md section 5): a
 * one-time code is printed to the API log instead of being emailed, and exchanging it returns
 * a signed session token (an HS256 JWT). It needs no external service or credential. Pending
 * codes live in memory, so they are lost when the API restarts. Production uses Cognito
 * (cognito-driver.ts).
 */
export class DevAuthDriver implements AuthDriver {
  readonly provider = 'dev' as const;
  readonly #key: Uint8Array;
  readonly #logger: FastifyBaseLogger;
  readonly #now: () => number;
  readonly #codeTtlSeconds: number;
  readonly #sessionTtlSeconds: number;
  readonly #maxAttempts: number;
  readonly #maxPendingCodes: number;
  readonly #maxWrongGuessesPerEmail: number;
  readonly #maxWrongGuesses: number;
  readonly #guessWindowMs: number;
  readonly #codes = new Map<string, PendingCode>();
  /** When each recent wrong guess was made, oldest first; at most `maxWrongGuesses` of them. */
  #wrongGuesses: { email: string; at: number }[] = [];

  constructor(options: DevAuthOptions) {
    this.#key = new TextEncoder().encode(options.secret);
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#codeTtlSeconds = options.codeTtlSeconds ?? 600;
    this.#sessionTtlSeconds = options.sessionTtlSeconds ?? 86_400;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#maxPendingCodes = options.maxPendingCodes ?? 10_000;
    this.#maxWrongGuessesPerEmail = options.maxWrongGuessesPerEmail ?? 10;
    this.#maxWrongGuesses = options.maxWrongGuesses ?? 100;
    this.#guessWindowMs = (options.guessWindowSeconds ?? 3600) * 1000;
  }

  /** Creates a new code for `email` (replacing any earlier one) and prints it to the log. */
  requestCode(email: string): { expiresInSeconds: number } {
    this.#refuseWhileGuessingIsLimited(email);
    this.#discardExpiredCodes();
    if (!this.#codes.has(email) && this.#codes.size >= this.#maxPendingCodes) {
      throw new ApiError('rate_limited', 'Too many sign-in codes are pending. Try again later.', {
        retryAfterSeconds: this.#codeTtlSeconds,
      });
    }
    const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
    this.#codes.set(email, {
      codeHash: hashCode(code),
      expiresAt: this.#now() + this.#codeTtlSeconds * 1000,
      attemptsLeft: this.#maxAttempts,
    });
    // The whole point of the dev driver: the code goes to the console, not to an inbox.
    this.#logger.info({ email, devSignInCode: code }, `dev sign-in code for ${email}: ${code}`);
    return { expiresInSeconds: this.#codeTtlSeconds };
  }

  /** Exchanges a code for a session token; the code works once. */
  async createSession(email: string, code: string): Promise<DevSession> {
    this.#refuseWhileGuessingIsLimited(email);
    const pending = this.#codes.get(email);
    if (!pending || pending.expiresAt <= this.#now()) {
      this.#codes.delete(email);
      throw new ApiError('unauthenticated', 'This sign-in code has expired. Request a new one.');
    }
    if (!timingSafeEqual(pending.codeHash, hashCode(code))) {
      this.#wrongGuesses.push({ email, at: this.#now() });
      pending.attemptsLeft -= 1;
      if (pending.attemptsLeft <= 0) {
        this.#codes.delete(email);
        throw new ApiError('unauthenticated', 'Too many wrong codes. Request a new one.');
      }
      throw new ApiError('unauthenticated', 'That sign-in code is not correct.');
    }
    this.#codes.delete(email);

    const issuedAt = Math.floor(this.#now() / 1000);
    const accessToken = await new SignJWT({ email })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(email)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.#sessionTtlSeconds)
      .sign(this.#key);
    return { accessToken, tokenType: 'Bearer', expiresInSeconds: this.#sessionTtlSeconds };
  }

  async verifyAccessToken(token: string): Promise<Identity | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.#key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
        requiredClaims: ['sub', 'exp', 'iat'],
        currentDate: new Date(this.#now()),
      });
      if (typeof payload.sub !== 'string' || payload.sub === '') return undefined;
      if (typeof payload.iat !== 'number') return undefined;
      return {
        provider: 'dev',
        subject: payload.sub,
        ...(typeof payload['email'] === 'string' ? { email: payload['email'] } : {}),
        issuedAt: payload.iat,
      };
    } catch {
      return undefined;
    }
  }

  registerRoutes(app: FastifyInstance): void {
    registerDevAuthRoutes(app, this);
  }

  /**
   * Refuses codes and guesses for `email` while it, or all emails together, used up their wrong
   * guesses in the window. The limits bound the 6-digit space an attacker can search: with the
   * defaults, ten guesses an hour for one email, and a hundred an hour in total.
   */
  #refuseWhileGuessingIsLimited(email: string): void {
    const now = this.#now();
    this.#wrongGuesses = this.#wrongGuesses.filter((guess) => guess.at > now - this.#guessWindowMs);
    const forEmail = this.#wrongGuesses.filter((guess) => guess.email === email);
    const limiting =
      forEmail.length >= this.#maxWrongGuessesPerEmail
        ? forEmail
        : this.#wrongGuesses.length >= this.#maxWrongGuesses
          ? this.#wrongGuesses
          : undefined;
    const oldest = limiting?.[0];
    if (oldest === undefined) return;
    throw new ApiError('rate_limited', 'Too many wrong sign-in codes. Try again later.', {
      retryAfterSeconds: Math.max(1, Math.ceil((oldest.at + this.#guessWindowMs - now) / 1000)),
    });
  }

  #discardExpiredCodes(): void {
    const now = this.#now();
    for (const [email, pending] of this.#codes) {
      if (pending.expiresAt <= now) this.#codes.delete(email);
    }
  }
}

function hashCode(code: string): Buffer {
  return createHash('sha256').update(code).digest();
}

/** Lowercased, trimmed, and shaped like `app_user.email` allows. */
const emailSchema = z
  .string({ error: 'is required' })
  .trim()
  .toLowerCase()
  .max(254, { error: 'must be at most 254 characters' })
  .regex(/^[^@\s]+@[^@\s]+$/, { error: 'must be an email address' });

const codeRequestSchema = z.object({ email: emailSchema });
const sessionRequestSchema = z.object({
  email: emailSchema,
  code: z.string({ error: 'is required' }).regex(/^\d{6}$/, { error: 'must be 6 digits' }),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  throw validationFailed(
    parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
  );
}

/**
 * Development-only sign-in endpoints. They exist only while `AUTH_DRIVER=dev` and are not part
 * of the versioned contract (in production the app signs in with Cognito directly).
 *
 * - `POST /dev/auth/codes` `{ email }` → 202 `{ expiresInSeconds }`; the code is in the API log.
 * - `POST /dev/auth/sessions` `{ email, code }` → 200 `{ accessToken, tokenType, expiresInSeconds }`.
 */
function registerDevAuthRoutes(app: FastifyInstance, driver: DevAuthDriver): void {
  app.post('/dev/auth/codes', async (request, reply) => {
    const { email } = parseBody(codeRequestSchema, request.body);
    return reply.code(202).send(driver.requestCode(email));
  });

  app.post('/dev/auth/sessions', async (request) => {
    const { email, code } = parseBody(sessionRequestSchema, request.body);
    return driver.createSession(email, code);
  });
}
