import { randomUUID } from 'crypto';

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import * as jose from 'jose';

import { createApp } from '../api/app';
import { UNAUTHORIZED, createAuthorizer } from '../api/authorizer';
import { GATEWAY_ERRORS, GATEWAY_HEADERS, gatewayBody } from '../api/gateway-responses';
import { ROUTE_TABLE } from '../api/route-table';
import { createTokenVerifier, type TokenVerifier } from '../lib/auth';
import { createLogger } from '../lib/log';
import { createMemoryStore, type MemoryStore } from '../lib/store/memory';
import type { Store } from '../lib/store';

export const SUPABASE_URL = 'https://project.supabase.example';
export const ISSUER = `${SUPABASE_URL}/auth/v1`;
export const USER_A = '11111111-1111-4111-8111-111111111111';
export const USER_B = '22222222-2222-4222-8222-222222222222';

export type SigningKey = {
  kid: string;
  alg: 'ES256' | 'RS256';
  privateKey: jose.KeyLike;
  jwk: jose.JWK;
};

export async function signingKey(alg: 'ES256' | 'RS256' = 'ES256'): Promise<SigningKey> {
  const { privateKey, publicKey } = await jose.generateKeyPair(alg);
  const kid = randomUUID();
  const jwk = { ...(await jose.exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { kid, alg, privateKey, jwk };
}

export type TokenOptions = {
  key: SigningKey;
  sub?: string | null;
  /** Claims from the web's access-token hook; null leaves the claim out. */
  accountStatus?: string | null;
  plan?: string | null;
  iss?: string;
  aud?: string;
  role?: string;
  isAnonymous?: boolean;
  expiresIn?: string | number;
  omitExp?: boolean;
  extra?: Record<string, unknown>;
};

export async function token({
  key,
  sub = USER_A,
  accountStatus = 'active',
  plan = 'free',
  iss = ISSUER,
  aud = 'authenticated',
  role = 'authenticated',
  isAnonymous = false,
  expiresIn = '1h',
  omitExp = false,
  extra = {},
}: TokenOptions): Promise<string> {
  let jwt = new jose.SignJWT({
    role,
    is_anonymous: isAnonymous,
    session_id: randomUUID(),
    ...(accountStatus === null ? {} : { account_status: accountStatus }),
    ...(plan === null ? {} : { plan }),
    ...extra,
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt();
  if (sub !== null) {
    jwt = jwt.setSubject(sub);
  }
  if (!omitExp) {
    jwt = jwt.setExpirationTime(expiresIn);
  }
  return jwt.sign(key.privateKey);
}

export function event(
  method: string,
  resource: string,
  options: {
    params?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    token?: string;
  } = {},
): APIGatewayProxyEvent {
  const path = Object.entries(options.params ?? {}).reduce(
    (current, [name, value]) => current.replace(`{${name}}`, value),
    resource,
  );
  return {
    httpMethod: method,
    resource,
    path: `/llm${path}`,
    pathParameters: options.params ?? null,
    queryStringParameters: options.query ?? null,
    multiValueQueryStringParameters: null,
    headers: {
      ...(options.body !== undefined || options.rawBody !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    multiValueHeaders: {},
    body: options.rawBody ?? (options.body === undefined ? null : JSON.stringify(options.body)),
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: { requestId: randomUUID() } as APIGatewayProxyEvent['requestContext'],
  };
}

export type TestApp = {
  /** The function behind a stand-in for API Gateway: the authorizer runs first, as deployed. */
  handle(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult>;
  store: MemoryStore;
  key: SigningKey;
  logs: string[];
  tokenFor(userId: string, options?: Partial<TokenOptions>): Promise<string>;
};

const PUBLIC_RESOURCES = new Set<string>(
  ROUTE_TABLE.filter((route) => 'public' in route && route.public).map((route) => route.path),
);

function gatewayError(type: keyof typeof GATEWAY_ERRORS, requestId: string) {
  return {
    statusCode: GATEWAY_ERRORS[type].status,
    headers: GATEWAY_HEADERS,
    body: gatewayBody(type, requestId),
  };
}

export async function testApp(
  options: { store?: Store; maxBodyBytes?: number; verifyToken?: TokenVerifier } = {},
): Promise<TestApp> {
  const key = await signingKey();
  const logs: string[] = [];
  const store = createMemoryStore();
  const logger = createLogger('debug', (line) => logs.push(line));
  const app = createApp({
    store: options.store ?? store,
    logger,
    maxBodyBytes: options.maxBodyBytes ?? 1_000_000,
  });
  const authorize = createAuthorizer({
    logger,
    verifyToken:
      options.verifyToken ??
      createTokenVerifier({
        SUPABASE_URL,
        SUPABASE_JWT_AUDIENCE: 'authenticated',
        SUPABASE_JWT_ALGORITHMS: ['ES256', 'RS256'],
        keys: jose.createLocalJWKSet({ keys: [key.jwk] }),
      }),
  });

  // Mirrors the deployed API: no authorizer on public routes; a missing Authorization header
  // never reaches the authorizer; the authorizer's context reaches the function.
  const handle = async (request: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const requestId = request.requestContext.requestId;
    if (PUBLIC_RESOURCES.has(request.resource.replace(/^\/llm(?=\/)/, ''))) {
      return app(request);
    }
    const header = Object.entries(request.headers).find(
      ([name]) => name.toLowerCase() === 'authorization',
    )?.[1];
    if (!header) {
      return gatewayError('UNAUTHORIZED', requestId);
    }
    let result;
    try {
      result = await authorize({
        type: 'TOKEN',
        authorizationToken: header,
        methodArn: `arn:aws:execute-api:us-west-1:000000000000:api/test/${request.httpMethod}${request.resource}`,
      });
    } catch (error) {
      const unauthorized = error instanceof Error && error.message === UNAUTHORIZED;
      return gatewayError(unauthorized ? 'UNAUTHORIZED' : 'AUTHORIZER_FAILURE', requestId);
    }
    if (result.policyDocument.Statement.some((statement) => statement.Effect !== 'Allow')) {
      return gatewayError('ACCESS_DENIED', requestId);
    }
    return app({
      ...request,
      requestContext: {
        ...request.requestContext,
        authorizer: { principalId: result.principalId, ...result.context },
      },
    });
  };

  return {
    handle,
    store,
    key,
    logs,
    tokenFor: (userId, extra = {}) => token({ key, sub: userId, ...extra }),
  };
}

export const json = (body: string) => (body ? (JSON.parse(body) as Record<string, any>) : null);
