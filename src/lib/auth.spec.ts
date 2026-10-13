import * as jose from 'jose';

import { ISSUER, SUPABASE_URL, USER_A, signingKey, token, type SigningKey } from '../test/helpers';
import { createTokenVerifier } from './auth';
import { ApiError } from './errors';

const verifierFor = (...keys: SigningKey[]) =>
  createTokenVerifier({
    SUPABASE_URL,
    SUPABASE_JWT_AUDIENCE: 'authenticated',
    SUPABASE_JWT_ALGORITHMS: ['ES256', 'RS256'],
    keys: jose.createLocalJWKSet({ keys: keys.map((key) => key.jwk) }),
  });

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error('expected the token to be rejected');
}

describe('createTokenVerifier', () => {
  let key: SigningKey;
  let verify: ReturnType<typeof createTokenVerifier>;

  beforeAll(async () => {
    key = await signingKey();
    verify = verifierFor(key);
  });

  it('accepts a valid access token', async () => {
    const auth = await verify(`Bearer ${await token({ key })}`);
    expect(auth.userId).toBe(USER_A);
    expect(auth.sessionId).toEqual(expect.any(String));
    expect(auth.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('reads the account_status and plan claims without judging them', async () => {
    const auth = await verify(
      `Bearer ${await token({ key, accountStatus: 'suspended', plan: 'pro' })}`,
    );
    expect(auth).toMatchObject({ accountStatus: 'suspended', plan: 'pro' });
    const bare = await verify(
      `Bearer ${await token({ key, accountStatus: null, plan: null, extra: { plan: 7 } })}`,
    );
    expect(bare).toMatchObject({ accountStatus: null, plan: null });
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['a bare token', 'eyJhbGciOiJFUzI1NiJ9.e30.sig'],
    ['garbage', 'Bearer not-a-jwt'],
  ])('rejects %s', async (_label, header) => {
    expect((await rejection(verify(header))).code).toBe('unauthorized');
  });

  it.each<[string, Parameters<typeof token>[0] extends infer T ? Omit<T & object, 'key'> : never]>([
    ['another issuer', { iss: 'https://other.supabase.example/auth/v1' }],
    ['another audience', { aud: 'anon' }],
    ['an expired token', { expiresIn: Math.floor(Date.now() / 1000) - 120 }],
    ['a token without exp', { omitExp: true }],
    ['a token without sub', { sub: null }],
    ['a non-uuid subject', { sub: 'service-account' }],
    ['the anon role', { role: 'anon' }],
    ['the service role', { role: 'service_role' }],
    ['an anonymous user', { isAnonymous: true }],
  ])('rejects %s', async (_label, options) => {
    expect((await rejection(verify(`Bearer ${await token({ key, ...options })}`))).code).toBe(
      'unauthorized',
    );
  });

  it('never reads user_metadata for authorization', async () => {
    const forged = await token({
      key,
      isAnonymous: true,
      extra: { user_metadata: { role: 'authenticated', is_anonymous: false } },
    });
    expect((await rejection(verify(`Bearer ${forged}`))).code).toBe('unauthorized');
  });

  it('rejects a token signed by a key outside the project JWKS', async () => {
    const stranger = await signingKey();
    expect((await rejection(verify(`Bearer ${await token({ key: stranger })}`))).code).toBe(
      'unauthorized',
    );
  });

  it('rejects the legacy symmetric HS256 mode', async () => {
    const secret = new TextEncoder().encode('legacy-jwt-secret-legacy-jwt-secret');
    const hs = await new jose.SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setSubject(USER_A)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret);
    expect((await rejection(verify(`Bearer ${hs}`))).code).toBe('unauthorized');
  });

  it('accepts tokens from the current and the next key during rotation', async () => {
    const next = await signingKey('RS256');
    const rotating = verifierFor(key, next);
    await expect(rotating(`Bearer ${await token({ key })}`)).resolves.toMatchObject({
      userId: USER_A,
    });
    await expect(rotating(`Bearer ${await token({ key: next })}`)).resolves.toMatchObject({
      userId: USER_A,
    });
  });

  it('reports unreachable signing keys as unavailable, not as a bad token', async () => {
    const offline = createTokenVerifier({
      SUPABASE_URL,
      SUPABASE_JWT_AUDIENCE: 'authenticated',
      SUPABASE_JWT_ALGORITHMS: ['ES256'],
      keys: async () => {
        throw new jose.errors.JWKSTimeout();
      },
    });
    expect((await rejection(offline(`Bearer ${await token({ key })}`))).code).toBe(
      'dependency_unavailable',
    );
  });
});
