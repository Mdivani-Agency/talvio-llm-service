/*
 * Bodies API Gateway returns when the authorizer refuses a request, in the contract's error
 * shape (`errorBodySchema`). serverless.ts deploys them; tests use them to stand in for API
 * Gateway. `$context.requestId` is the same id the function uses as its correlation id.
 */

type GatewayError = {
  status: number;
  code: 'unauthorized' | 'dependency_unavailable';
  message: string;
  retryable: boolean;
};

export const GATEWAY_ERRORS = {
  /** No token, or a token that fails verification. */
  UNAUTHORIZED: {
    status: 401,
    code: 'unauthorized',
    message: 'Sign in to use AI features.',
    retryable: false,
  },
  /** The authorizer denied a valid token: inactive account or unknown plan. */
  ACCESS_DENIED: {
    status: 401,
    code: 'unauthorized',
    message: 'AI features are not available for this account.',
    retryable: false,
  },
  /** The authorizer failed, e.g. the signing keys could not be fetched. */
  AUTHORIZER_FAILURE: {
    status: 503,
    code: 'dependency_unavailable',
    message: 'AI features are temporarily unavailable. Try again later.',
    retryable: true,
  },
  AUTHORIZER_CONFIGURATION_ERROR: {
    status: 503,
    code: 'dependency_unavailable',
    message: 'AI features are temporarily unavailable. Try again later.',
    retryable: true,
  },
} as const satisfies Record<string, GatewayError>;

export type GatewayResponseType = keyof typeof GATEWAY_ERRORS;

export const GATEWAY_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** The body for one response type, with the given correlation id (a template in API Gateway). */
export function gatewayBody(type: GatewayResponseType, correlationId: string): string {
  const { code, message, retryable } = GATEWAY_ERRORS[type];
  return JSON.stringify({ error: { code, message, retryable, correlationId } });
}
