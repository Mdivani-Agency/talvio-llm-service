import { randomUUID } from 'crypto';

import type { APIGatewayProxyEvent } from 'aws-lambda';
import * as jose from 'jose';

import { createApp } from '../api/app';
import { createTokenVerifier } from '../lib/auth';
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
  handle: ReturnType<typeof createApp>;
  store: MemoryStore;
  key: SigningKey;
  logs: string[];
  tokenFor(userId: string, options?: Partial<TokenOptions>): Promise<string>;
};

export async function testApp(
  options: { store?: Store; maxBodyBytes?: number } = {},
): Promise<TestApp> {
  const key = await signingKey();
  const logs: string[] = [];
  const store = createMemoryStore();
  const handle = createApp({
    store: options.store ?? store,
    logger: createLogger('debug', (line) => logs.push(line)),
    verifyToken: createTokenVerifier({
      SUPABASE_URL,
      SUPABASE_JWT_AUDIENCE: 'authenticated',
      SUPABASE_JWT_ALGORITHMS: ['ES256', 'RS256'],
      keys: jose.createLocalJWKSet({ keys: [key.jwk] }),
    }),
    maxBodyBytes: options.maxBodyBytes ?? 1_000_000,
  });
  return {
    handle,
    store,
    key,
    logs,
    tokenFor: (userId, extra = {}) => token({ key, sub: userId, ...extra }),
  };
}

export const json = (body: string) => (body ? (JSON.parse(body) as Record<string, any>) : null);
