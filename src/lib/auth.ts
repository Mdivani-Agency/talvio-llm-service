import * as jose from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';

import type { Config } from './config';
import { ApiError, unauthorized } from './errors';

/*
 * Independent verification of Supabase access tokens (design §6). Checks signature against the
 * project's published signing keys (JWKS, so key rotation needs no deploy), issuer, audience,
 * allowed asymmetric algorithms, expiry, subject and role, and rejects anonymous users.
 * user_metadata is never read: users can edit it.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Small allowance for clock skew between Supabase and Lambda. */
const CLOCK_TOLERANCE_SECONDS = 30;

export type AuthContext = {
  userId: string;
  /** Supabase auth session id, when the token carries one. */
  sessionId: string | null;
  expiresAt: Date;
};

export type TokenVerifier = (authorizationHeader: string | undefined) => Promise<AuthContext>;

type VerifierOptions = Pick<
  Config,
  'SUPABASE_URL' | 'SUPABASE_JWT_AUDIENCE' | 'SUPABASE_JWT_ALGORITHMS'
> & {
  /** Injected in tests; defaults to the project's remote JWKS, cached per container. */
  keys?: JWTVerifyGetKey;
};

function bearerToken(header: string | undefined): string {
  const match = header?.match(/^Bearer ([A-Za-z0-9._~+/=-]+)$/i);
  if (!match?.[1]) {
    throw unauthorized();
  }
  return match[1];
}

function checkClaims(payload: JWTPayload): AuthContext {
  const sub = payload.sub;
  if (!sub || !UUID_RE.test(sub)) {
    throw unauthorized();
  }
  if (payload.role !== 'authenticated') {
    throw unauthorized();
  }
  if (payload.is_anonymous === true) {
    throw unauthorized('Create an account to use AI features.');
  }
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  return { userId: sub.toLowerCase(), sessionId, expiresAt: new Date((payload.exp ?? 0) * 1000) };
}

export function createTokenVerifier(options: VerifierOptions): TokenVerifier {
  const issuer = `${options.SUPABASE_URL}/auth/v1`;
  const keys = options.keys ?? jose.createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

  return async (authorizationHeader) => {
    const token = bearerToken(authorizationHeader);
    try {
      const { payload } = await jose.jwtVerify(token, keys, {
        issuer,
        audience: options.SUPABASE_JWT_AUDIENCE,
        algorithms: options.SUPABASE_JWT_ALGORITHMS,
        requiredClaims: ['exp', 'iat', 'sub'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      return checkClaims(payload);
    } catch (error) {
      // The signing keys could not be fetched: not the caller's fault.
      if (error instanceof jose.errors.JWKSTimeout || error instanceof TypeError) {
        throw new ApiError('dependency_unavailable');
      }
      if (error instanceof jose.errors.JOSEError) {
        throw unauthorized();
      }
      throw error;
    }
  };
}
