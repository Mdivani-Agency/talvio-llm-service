import type { APIGatewayTokenAuthorizerEvent } from 'aws-lambda';
import * as jose from 'jose';

import { createTokenVerifier } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { createLogger } from '../lib/log';
import { SUPABASE_URL, USER_A, signingKey, token, type SigningKey } from '../test/helpers';
import { UNAUTHORIZED, createAuthorizer } from './authorizer';

const METHOD_ARN = 'arn:aws:execute-api:us-west-1:000000000000:abc123/dev/GET/v1/jobs';

const authorizerEvent = (authorizationToken: string): APIGatewayTokenAuthorizerEvent => ({
  type: 'TOKEN',
  authorizationToken,
  methodArn: METHOD_ARN,
});

describe('createAuthorizer', () => {
  let key: SigningKey;
  let logs: string[];
  let authorize: ReturnType<typeof createAuthorizer>;

  beforeEach(async () => {
    key ??= await signingKey();
    logs = [];
    authorize = createAuthorizer({
      logger: createLogger('debug', (line) => logs.push(line)),
      verifyToken: createTokenVerifier({
        SUPABASE_URL,
        SUPABASE_JWT_AUDIENCE: 'authenticated',
        SUPABASE_JWT_ALGORITHMS: ['ES256', 'RS256'],
        keys: jose.createLocalJWKSet({ keys: [key.jwk] }),
      }),
    });
  });

  it('allows an active user on a known plan for the called method only', async () => {
    const result = await authorize(authorizerEvent(`Bearer ${await token({ key })}`));
    expect(result.principalId).toBe(USER_A);
    expect(result.policyDocument.Statement).toEqual([
      { Action: 'execute-api:Invoke', Effect: 'Allow', Resource: METHOD_ARN },
    ]);
    expect(result.context).toEqual({
      userId: USER_A,
      sessionId: expect.any(String),
      plan: 'free',
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it.each([
    ['a suspended account', { accountStatus: 'suspended' }],
    ['a missing account_status', { accountStatus: null }],
    ['a missing plan', { plan: null }],
    ['an unknown plan', { plan: 'enterprise' }],
    ['a non-string plan', { plan: null, extra: { plan: ['free'] } }],
  ])('denies %s without a context', async (_label, options) => {
    const result = await authorize(authorizerEvent(`Bearer ${await token({ key, ...options })}`));
    expect(result.policyDocument.Statement).toEqual([
      { Action: 'execute-api:Invoke', Effect: 'Deny', Resource: METHOD_ARN },
    ]);
    expect(result.context).toBeUndefined();
  });

  it.each([
    ['an invalid token', 'Bearer not-a-jwt'],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
  ])('answers Unauthorized for %s', async (_label, header) => {
    await expect(authorize(authorizerEvent(header))).rejects.toThrow(new Error(UNAUTHORIZED));
  });

  it('answers Unauthorized for an anonymous user', async () => {
    const anonymous = await token({ key, isAnonymous: true });
    await expect(authorize(authorizerEvent(`Bearer ${anonymous}`))).rejects.toThrow(
      new Error(UNAUTHORIZED),
    );
  });

  it('fails without Unauthorized when the signing keys are unreachable', async () => {
    const offline = createAuthorizer({
      logger: createLogger('error', () => undefined),
      verifyToken: async () => {
        throw new ApiError('dependency_unavailable');
      },
    });
    const failure = offline(authorizerEvent('Bearer x.y.z'));
    await expect(failure).rejects.toThrow();
    await expect(failure).rejects.not.toThrow(new Error(UNAUTHORIZED));
  });

  it('logs outcomes without tokens or user ids', async () => {
    const valid = await token({ key });
    await authorize(authorizerEvent(`Bearer ${valid}`));
    await authorize(authorizerEvent(`Bearer ${await token({ key, accountStatus: 'suspended' })}`));
    const output = logs.join('\n');
    expect(output).toContain('"code":"allowed"');
    expect(output).toContain('"code":"account_inactive"');
    expect(output).not.toContain(valid);
    expect(output).not.toContain(USER_A);
  });
});
