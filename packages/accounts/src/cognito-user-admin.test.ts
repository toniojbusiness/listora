import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AwsCognitoUserAdmin } from './cognito-user-admin.ts';
import { subjectSha256 } from './identity.ts';

interface Received {
  target: string | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
}

interface Reply {
  status: number;
  type?: string;
  body?: unknown;
}

const GET_USER = 'AWSCognitoIdentityProviderService.AdminGetUser';
const DELETE_USER = 'AWSCognitoIdentityProviderService.AdminDeleteUser';
const USERNAME = 'SignInWithApple_000123';
const SUB = '8a1b2c3d-0000-4000-8000-000000000001';
const USER = { username: USERNAME, subjectSha256: subjectSha256(SUB) };

function userWithSub(sub: string): Reply {
  return {
    status: 200,
    body: {
      Username: USERNAME,
      UserAttributes: [
        { Name: 'email', Value: 'ada@example.com' },
        { Name: 'sub', Value: sub },
      ],
    },
  };
}

/**
 * Answers like the Cognito user pools API (AWS JSON 1.1 protocol) on 127.0.0.1, so the real
 * SDK client runs end to end without AWS. `replies` sets the answer per operation.
 */
describe('AwsCognitoUserAdmin', () => {
  let server: Server;
  let received: Received[] = [];
  let replies: Record<string, Reply> = {};

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const target = request.headers['x-amz-target'];
        const targetName = typeof target === 'string' ? target : undefined;
        received.push({
          target: targetName,
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
        });
        const reply = replies[targetName ?? ''] ?? { status: 200 };
        const headers: Record<string, string> = {
          'content-type': 'application/x-amz-json-1.1',
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
    replies = { [GET_USER]: userWithSub(SUB) };
  });

  function admin(): AwsCognitoUserAdmin {
    const { port } = server.address() as AddressInfo;
    return new AwsCognitoUserAdmin({
      region: 'us-east-1',
      userPoolId: 'us-east-1_TestPool1',
      client: {
        endpoint: `http://127.0.0.1:${String(port)}`,
        credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' },
        maxAttempts: 1,
      },
    });
  }

  it('checks the user is the deleted identity, then sends a signed AdminDeleteUser', async () => {
    await admin().deleteUser(USER);
    expect(received.map((request) => request.target)).toEqual([GET_USER, DELETE_USER]);
    for (const request of received) {
      expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
      expect(request.body).toEqual({ UserPoolId: 'us-east-1_TestPool1', Username: USERNAME });
    }
  });

  it('leaves a newer user who got the same username alone', async () => {
    replies[GET_USER] = userWithSub('9f9f9f9f-0000-4000-8000-000000000002');
    await admin().deleteUser(USER);
    expect(received.map((request) => request.target)).toEqual([GET_USER]);
  });

  it('treats a user that no longer exists as deleted', async () => {
    replies[GET_USER] = { status: 400, type: 'UserNotFoundException' };
    await expect(admin().deleteUser(USER)).resolves.toBeUndefined();
    expect(received.map((request) => request.target)).toEqual([GET_USER]);

    replies[GET_USER] = userWithSub(SUB);
    replies[DELETE_USER] = { status: 400, type: 'UserNotFoundException' };
    await expect(admin().deleteUser(USER)).resolves.toBeUndefined();
  });

  it('fails when Cognito refuses or breaks', async () => {
    for (const target of [GET_USER, DELETE_USER]) {
      for (const failure of [
        { status: 400, type: 'NotAuthorizedException' },
        { status: 400, type: 'TooManyRequestsException' },
        { status: 500, type: 'InternalErrorException' },
      ]) {
        replies = { [GET_USER]: userWithSub(SUB), [target]: failure };
        await expect(admin().deleteUser(USER), `${target} ${failure.type}`).rejects.toThrow();
      }
    }
  });

  it('fails rather than guess when the user has no sub', async () => {
    replies[GET_USER] = { status: 200, body: { Username: USERNAME, UserAttributes: [] } };
    await expect(admin().deleteUser(USER)).rejects.toThrow(/without a sub/);
    expect(received.map((request) => request.target)).toEqual([GET_USER]);
  });
});
