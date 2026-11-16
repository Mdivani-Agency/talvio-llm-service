import type { BlobStore } from '@lib/blob';
import type { Logger } from '@lib/log';
import type { OutboxEvent, Store } from '@lib/store';

import type { AuthContext } from './authorizer';

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
  blobs: BlobStore;
  logger: Logger;
  /** Pipeline release new jobs are pinned to. */
  pipelineReleaseId: string;
  /** Hands an admitted job's outbox event to its work queue right away; the dispatcher repairs a miss. */
  dispatch: (event: OutboxEvent) => Promise<void>;
};

export type RouteHandler = (request: RouteRequest, deps: Deps) => Promise<RouteResult>;

export type Route = {
  method: HttpMethod;
  /** API Gateway resource path below the `llm` base path, e.g. `/v1/jobs/{jobId}`. */
  path: string;
  /** Public routes have no authorizer. Only /v1/health is public. */
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

/** The signed-in user's plan, from the verified token. */
export function planOf(request: RouteRequest): AuthContext['plan'] {
  if (!request.auth) {
    throw new Error('route requires authentication');
  }
  return request.auth.plan;
}
