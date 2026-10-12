import { randomUUID } from 'crypto';

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import type { TokenVerifier } from '@lib/auth';
import { ApiError, unauthorized } from '@lib/errors';
import { userRef, type LogFields } from '@lib/log';

import { ROUTES } from './routes';
import type { Deps, Route, RouteRequest, RouteResult } from './types';

export type AppDeps = Deps & {
  verifyToken: TokenVerifier;
  maxBodyBytes: number;
  now?: () => Date;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORRELATION_RE = /^[A-Za-z0-9-]{8,128}$/;

/** Responses are private and never cached; browsers reach them only through the web proxy. */
const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function lowercaseHeaders(headers: APIGatewayProxyEvent['headers']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function findRoute(event: APIGatewayProxyEvent): Route | undefined {
  // `resource` is the template (`/v1/jobs/{jobId}`) whatever base path the domain maps.
  const resource = event.resource.replace(/^\/llm(?=\/)/, '');
  return ROUTES.find((route) => route.method === event.httpMethod && route.path === resource);
}

/** Path ids are UUIDs; anything else cannot exist, so it is a plain 404. */
function pathParams(event: APIGatewayProxyEvent): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(event.pathParameters ?? {})) {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw new ApiError('not_found');
    }
    params[name] = value.toLowerCase();
  }
  return params;
}

function parseBody(event: APIGatewayProxyEvent, headers: Record<string, string>, limit: number) {
  if (event.body === null || event.body === undefined || event.body === '') {
    return undefined;
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  if (Buffer.byteLength(raw, 'utf8') > limit) {
    throw new ApiError('payload_too_large');
  }
  const contentType = headers['content-type'] ?? '';
  if (!/^application\/json(\s*;|$)/i.test(contentType)) {
    throw new ApiError('invalid_request', {
      message: 'Send JSON with Content-Type: application/json.',
    });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // The parser's message quotes the body, so it is dropped.
    throw new ApiError('invalid_request', { message: 'The request body is not valid JSON.' });
  }
}

function errorResult(error: ApiError, correlationId: string): RouteResult {
  return {
    status: error.status,
    headers: error.headers,
    body: {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        correlationId,
        ...(error.issues ? { issues: error.issues } : {}),
      },
    },
  };
}

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());

  return async function handle(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const started = Date.now();
    const headers = lowercaseHeaders(event.headers);
    const requestId = event.requestContext?.requestId;
    const correlationId = requestId && CORRELATION_RE.test(requestId) ? requestId : randomUUID();
    const route = findRoute(event);
    const log: LogFields = {
      event: 'request',
      correlationId,
      method: event.httpMethod,
      route: route?.path ?? 'unmatched',
    };

    let result: RouteResult;
    try {
      if (!route) {
        throw new ApiError('not_found');
      }
      let auth: RouteRequest['auth'] = null;
      if (!route.public) {
        auth = await deps.verifyToken(headers.authorization);
        log.user = userRef(auth.userId);
        // A still-valid token of a deleted or revoked account is refused.
        if (!(await deps.store.accounts.isActive(auth.userId))) {
          throw unauthorized();
        }
      }
      result = await route.handler(
        {
          auth,
          params: pathParams(event),
          query: Object.fromEntries(
            Object.entries(event.queryStringParameters ?? {}).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          ),
          headers,
          body: parseBody(event, headers, deps.maxBodyBytes),
          correlationId,
          now: now(),
        },
        deps,
      );
    } catch (error) {
      if (error instanceof ApiError) {
        result = errorResult(error, correlationId);
        log.code = error.code;
      } else {
        result = errorResult(new ApiError('internal_error'), correlationId);
        log.code = 'internal_error';
        log.errorName = error instanceof Error ? error.name : typeof error;
      }
    }

    log.status = result.status;
    log.durationMs = Date.now() - started;
    deps.logger.log(result.status >= 500 ? 'error' : 'info', log);

    return {
      statusCode: result.status,
      headers: { ...BASE_HEADERS, ...result.headers, 'X-Correlation-Id': correlationId },
      body: result.body === undefined ? '' : JSON.stringify(result.body),
    };
  };
}
