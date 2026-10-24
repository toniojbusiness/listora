import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AwsCognitoUserAdmin } from './cognito-user-admin.ts';

interface Received {
  headers: IncomingHttpHeaders;
  body: unknown;
}

/**
 * Answers like the Cognito user pools API (AWS JSON 1.1 protocol) on 127.0.0.1, so the real
 * SDK client runs end to end without AWS. `reply` sets the next answer.
 */
describe('AwsCognitoUserAdmin', () => {
  let server: Server;
  let received: Received[] = [];
  let reply: { status: number; type?: string } = { status: 200 };

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
        });
        const headers: Record<string, string> = {
          'content-type': 'application/x-amz-json-1.1',
        };
        if (reply.type !== undefined) headers['x-amzn-errortype'] = reply.type;
        response
          .writeHead(reply.status, headers)
          .end(
            JSON.stringify(
              reply.type === undefined ? {} : { __type: reply.type, message: 'fake failure' },
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
    reply = { status: 200 };
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

  it('sends a signed AdminDeleteUser for the pool and username', async () => {
    await admin().deleteUser('signinwithapple_000123');
    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.headers['x-amz-target']).toBe(
      'AWSCognitoIdentityProviderService.AdminDeleteUser',
    );
    expect(request?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
    expect(request?.body).toEqual({
      UserPoolId: 'us-east-1_TestPool1',
      Username: 'signinwithapple_000123',
    });
  });

  it('treats a user that no longer exists as deleted', async () => {
    reply = { status: 400, type: 'UserNotFoundException' };
    await expect(admin().deleteUser('signinwithapple_000123')).resolves.toBeUndefined();
  });

  it('fails when Cognito refuses or breaks', async () => {
    for (const failure of [
      { status: 400, type: 'NotAuthorizedException' },
      { status: 400, type: 'TooManyRequestsException' },
      { status: 500, type: 'InternalErrorException' },
    ]) {
      reply = failure;
      await expect(admin().deleteUser('signinwithapple_000123'), failure.type).rejects.toThrow();
    }
  });
});
