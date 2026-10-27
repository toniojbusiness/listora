import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AwsCognitoInviteeDirectory, AwsSesRecipientVerifier } from './invitees.ts';

interface Received {
  /** The Cognito operation (`x-amz-target`), or the SES request's method and path. */
  call: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

interface Reply {
  status: number;
  type?: string;
  body?: unknown;
}

const COGNITO = 'AWSCognitoIdentityProviderService.';
const EMAIL = 'maria@example.com';
const IDENTITY_PATH = `/v2/email/identities/${encodeURIComponent(EMAIL)}`;
const CREDENTIALS = { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' };

/**
 * Answers like the Cognito user pools API (AWS JSON 1.1) and SES v2 (REST JSON) on 127.0.0.1,
 * so the real SDK clients run end to end without AWS. `replies` sets the answer per call.
 */
describe('invitee users', () => {
  let server: Server;
  let received: Received[] = [];
  let replies: Record<string, Reply> = {};

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const target = request.headers['x-amz-target'];
        const call =
          typeof target === 'string'
            ? target.slice(COGNITO.length)
            : `${request.method ?? ''} ${request.url ?? ''}`;
        const text = Buffer.concat(chunks).toString();
        received.push({
          call,
          headers: request.headers,
          body: text === '' ? undefined : (JSON.parse(text) as unknown),
        });
        const reply = replies[call] ?? { status: 200 };
        const headers: Record<string, string> = {
          'content-type':
            typeof target === 'string' ? 'application/x-amz-json-1.1' : 'application/json',
        };
        if (reply.type !== undefined) headers['x-amzn-errortype'] = reply.type;
        response
          .writeHead(reply.status, headers)
          .end(
            JSON.stringify(
              reply.type === undefined
                ? (reply.body ?? {})
                : { __type: reply.type, message: 'fake failure' },
            ),
          );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    received = [];
    replies = {};
  });

  function endpoint(): string {
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  function recipients(): AwsSesRecipientVerifier {
    return new AwsSesRecipientVerifier({
      region: 'us-east-1',
      client: { endpoint: endpoint(), credentials: CREDENTIALS, maxAttempts: 1 },
    });
  }

  function directory(options: { sandbox?: boolean } = {}): AwsCognitoInviteeDirectory {
    return new AwsCognitoInviteeDirectory({
      region: 'us-east-1',
      userPoolId: 'us-east-1_TestPool1',
      ...(options.sandbox === true ? { recipients: recipients() } : {}),
      client: { endpoint: endpoint(), credentials: CREDENTIALS, maxAttempts: 1 },
    });
  }

  const calls = () => received.map((request) => request.call);

  describe('AwsCognitoInviteeDirectory', () => {
    it('creates a verified user named by the email, without a password or an invitation', async () => {
      await expect(directory().admit(EMAIL)).resolves.toBe('deliverable');
      expect(calls()).toEqual(['AdminCreateUser']);
      expect(received[0]?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
      expect(received[0]?.body).toEqual({
        UserPoolId: 'us-east-1_TestPool1',
        Username: EMAIL,
        UserAttributes: [
          { Name: 'email', Value: EMAIL },
          { Name: 'email_verified', Value: 'true' },
        ],
        MessageAction: 'SUPPRESS',
      });
    });

    it('admits an existing user again without failing', async () => {
      replies['AdminCreateUser'] = { status: 400, type: 'UsernameExistsException' };
      await expect(directory().admit(EMAIL)).resolves.toBe('deliverable');
    });

    it('signs the person out everywhere, then disables them', async () => {
      await directory().suspend(EMAIL);
      expect(calls()).toEqual(['AdminUserGlobalSignOut', 'AdminDisableUser']);
      for (const request of received) {
        expect(request.body).toEqual({ UserPoolId: 'us-east-1_TestPool1', Username: EMAIL });
      }
    });

    it('treats a user that is gone as suspended and forgotten', async () => {
      replies['AdminUserGlobalSignOut'] = { status: 400, type: 'UserNotFoundException' };
      replies['AdminDisableUser'] = { status: 400, type: 'UserNotFoundException' };
      replies['AdminDeleteUser'] = { status: 400, type: 'UserNotFoundException' };
      await expect(directory().suspend(EMAIL)).resolves.toBeUndefined();
      await expect(directory().forget(EMAIL)).resolves.toBeUndefined();
    });

    it('enables a suspended user, and recreates one that is gone', async () => {
      await expect(directory().resume(EMAIL)).resolves.toBe('deliverable');
      expect(calls()).toEqual(['AdminEnableUser']);

      received = [];
      replies['AdminEnableUser'] = { status: 400, type: 'UserNotFoundException' };
      await expect(directory().resume(EMAIL)).resolves.toBe('deliverable');
      expect(calls()).toEqual(['AdminEnableUser', 'AdminCreateUser']);
    });

    it('fails when Cognito refuses or breaks', async () => {
      for (const failure of [
        { status: 400, type: 'NotAuthorizedException' },
        { status: 400, type: 'TooManyRequestsException' },
        { status: 500, type: 'InternalErrorException' },
      ]) {
        replies = {
          AdminCreateUser: failure,
          AdminDisableUser: failure,
          AdminDeleteUser: failure,
          AdminEnableUser: failure,
        };
        await expect(directory().admit(EMAIL), failure.type).rejects.toThrow();
        await expect(directory().suspend(EMAIL), failure.type).rejects.toThrow();
        await expect(directory().forget(EMAIL), failure.type).rejects.toThrow();
        await expect(directory().resume(EMAIL), failure.type).rejects.toThrow();
      }
    });

    it("in SES's sandbox, also starts the address's verification and forgets it with the user", async () => {
      replies[`GET ${IDENTITY_PATH}`] = { status: 404, type: 'NotFoundException' };
      await expect(directory({ sandbox: true }).admit(EMAIL)).resolves.toBe('verification_sent');
      expect(calls()).toEqual([
        'AdminCreateUser',
        `GET ${IDENTITY_PATH}`,
        'POST /v2/email/identities',
      ]);
      expect(received[2]?.body).toEqual({ EmailIdentity: EMAIL });

      received = [];
      await directory({ sandbox: true }).forget(EMAIL);
      expect(calls()).toEqual(['AdminDeleteUser', `DELETE ${IDENTITY_PATH}`]);
    });
  });

  describe('AwsSesRecipientVerifier', () => {
    function identity(status: string): Reply {
      return { status: 200, body: { IdentityType: 'EMAIL_ADDRESS', VerificationStatus: status } };
    }

    it('reports a verified address as deliverable without sending anything', async () => {
      replies[`GET ${IDENTITY_PATH}`] = identity('SUCCESS');
      await expect(recipients().ensure(EMAIL)).resolves.toBe('deliverable');
      expect(calls()).toEqual([`GET ${IDENTITY_PATH}`]);
    });

    it('waits for a link already sent, without sending another', async () => {
      replies[`GET ${IDENTITY_PATH}`] = identity('PENDING');
      await expect(recipients().ensure(EMAIL)).resolves.toBe('verification_sent');
      expect(calls()).toEqual([`GET ${IDENTITY_PATH}`]);
    });

    it('sends a new link when the last one expired or failed', async () => {
      for (const status of ['FAILED', 'TEMPORARY_FAILURE', 'NOT_STARTED']) {
        received = [];
        replies[`GET ${IDENTITY_PATH}`] = identity(status);
        await expect(recipients().ensure(EMAIL), status).resolves.toBe('verification_sent');
        expect(calls(), status).toEqual([
          `GET ${IDENTITY_PATH}`,
          `DELETE ${IDENTITY_PATH}`,
          'POST /v2/email/identities',
        ]);
      }
    });

    it('accepts an identity a concurrent call created', async () => {
      replies[`GET ${IDENTITY_PATH}`] = { status: 404, type: 'NotFoundException' };
      replies['POST /v2/email/identities'] = { status: 400, type: 'AlreadyExistsException' };
      await expect(recipients().ensure(EMAIL)).resolves.toBe('verification_sent');
    });

    it('fails when SES refuses or breaks', async () => {
      replies[`GET ${IDENTITY_PATH}`] = { status: 404, type: 'NotFoundException' };
      replies['POST /v2/email/identities'] = { status: 429, type: 'TooManyRequestsException' };
      await expect(recipients().ensure(EMAIL)).rejects.toThrow();
      replies[`GET ${IDENTITY_PATH}`] = { status: 500, type: 'InternalFailure' };
      await expect(recipients().ensure(EMAIL)).rejects.toThrow();
    });
  });
});
