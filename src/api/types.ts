import type { AuthContext } from '@lib/auth';
import type { Logger } from '@lib/log';
import type { Store } from '@lib/store';

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export type RouteRequest = {
  /** Null only on public routes. */
  auth: AuthContext | null;
  params: Record<string, string>;
  query: Record<string, string>;
  /** Lowercased header names. */
  headers: Record<string, string>;
  body: unknown;
  correlationId: string;
  now: Date;
};

export type RouteResult = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export type Deps = {
  store: Store;
  logger: Logger;
};

export type RouteHandler = (request: RouteRequest, deps: Deps) => Promise<RouteResult>;

export type Route = {
  method: HttpMethod;
  /** API Gateway resource path below the `llm` base path, e.g. `/v1/jobs/{jobId}`. */
  path: string;
  /** Public routes skip authentication. Only /v1/health is public. */
  public?: boolean;
  handler: RouteHandler;
};

/** The signed-in user of an authenticated route. */
export function userOf(request: RouteRequest): string {
  if (!request.auth) {
    throw new Error('route requires authentication');
  }
  return request.auth.userId;
}
