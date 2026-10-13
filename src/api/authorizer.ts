import type {
  APIGatewayAuthorizerResult,
  APIGatewayProxyEvent,
  APIGatewayTokenAuthorizerEvent,
} from 'aws-lambda';

import type { TokenVerifier } from '@lib/auth';
import { ApiError, unauthorized } from '@lib/errors';
import { userRef, type LogFields, type Logger } from '@lib/log';
import { isPlan, type Plan } from '@lib/plans';

/*
 * API Gateway TOKEN authorizer for every route except health (MDI-440). It verifies the
 * Supabase access token and reads two claims that talvio-web-app's custom access-token hook
 * adds, so the service never queries the web's database:
 *   account_status  must be 'active'
 *   plan            must be a plan in PLANS
 * Tokens live 15 minutes, so a suspension or plan change takes effect within one token
 * lifetime. Results are not cached (resultTtlInSeconds 0) and each policy allows only the
 * method that was called.
 *
 * API Gateway turns the outcomes into gateway responses (gateway-responses.ts):
 *   bad or missing token          throw 'Unauthorized'  401 unauthorized
 *   inactive account, unknown plan Deny policy          401 unauthorized ("not available")
 *   signing keys unreachable      any other error       503 dependency_unavailable
 */

/** The signed-in user, as handlers see it. */
export type AuthContext = {
  userId: string;
  /** Supabase auth session id, when the token carries one. */
  sessionId: string | null;
  plan: Plan;
  expiresAt: Date;
};

/** API Gateway context values must be strings, numbers or booleans. */
type AuthorizerContext = {
  userId: string;
  sessionId: string;
  plan: Plan;
  expiresAt: string;
};

export type AuthorizerDeps = {
  verifyToken: TokenVerifier;
  logger: Logger;
};

/** The exact error message API Gateway maps to a 401. */
export const UNAUTHORIZED = 'Unauthorized';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function policy(
  principalId: string,
  effect: 'Allow' | 'Deny',
  methodArn: string,
  context?: AuthorizerContext,
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: methodArn }],
    },
    ...(context ? { context } : {}),
  };
}

export function createAuthorizer(deps: AuthorizerDeps) {
  return async function authorize(
    event: APIGatewayTokenAuthorizerEvent,
  ): Promise<APIGatewayAuthorizerResult> {
    const log: LogFields = { event: 'authorize' };
    try {
      const token = await deps.verifyToken(event.authorizationToken);
      log.user = userRef(token.userId);
      if (token.accountStatus !== 'active') {
        log.code = 'account_inactive';
        return policy(token.userId, 'Deny', event.methodArn);
      }
      if (!isPlan(token.plan)) {
        log.code = 'unknown_plan';
        return policy(token.userId, 'Deny', event.methodArn);
      }
      log.code = 'allowed';
      return policy(token.userId, 'Allow', event.methodArn, {
        userId: token.userId,
        sessionId: token.sessionId ?? '',
        plan: token.plan,
        expiresAt: token.expiresAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'unauthorized') {
        log.code = 'unauthorized';
        throw new Error(UNAUTHORIZED);
      }
      log.code = error instanceof ApiError ? error.code : 'internal_error';
      log.errorName = error instanceof Error ? error.name : typeof error;
      throw new Error('Authorizer unavailable');
    } finally {
      deps.logger.log(log.code === 'allowed' ? 'debug' : 'info', log);
    }
  };
}

/**
 * Reads the authorizer's context from a proxy event. API Gateway only invokes the function
 * after an Allow, so a missing or malformed context means the route was deployed without the
 * authorizer: refuse rather than trust the request.
 */
export function readAuthContext(event: APIGatewayProxyEvent): AuthContext {
  const context = (event.requestContext?.authorizer ?? {}) as Partial<
    Record<keyof AuthorizerContext, unknown>
  >;
  const { userId, sessionId, plan, expiresAt } = context;
  const expires = typeof expiresAt === 'string' ? new Date(expiresAt) : null;
  if (
    typeof userId !== 'string' ||
    !UUID_RE.test(userId) ||
    !isPlan(plan) ||
    !expires ||
    Number.isNaN(expires.getTime())
  ) {
    throw unauthorized();
  }
  return {
    userId,
    sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
    plan,
    expiresAt: expires,
  };
}
