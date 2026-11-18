import * as documents from './handlers/documents';
import * as jobs from './handlers/jobs';
import * as sessions from './handlers/sessions';
import { ROUTE_TABLE, type RouteId } from './route-table';
import type { Route, RouteHandler } from './types';

const HANDLERS: Record<RouteId, RouteHandler> = {
  health: async () => ({ status: 200, body: { status: 'ok' } }),
  createDocument: documents.createDocument,
  getDocument: documents.getDocument,
  deleteDocument: documents.deleteDocument,
  completeDocument: documents.completeDocument,
  createSession: sessions.createSession,
  getSession: sessions.getSession,
  deleteSession: sessions.deleteSession,
  createContext: sessions.createContext,
  submitAnswers: sessions.submitAnswers,
  createJob: jobs.createJob,
  listJobs: jobs.listJobs,
  getJob: jobs.getJob,
  deleteJob: jobs.deleteJob,
  cancelJob: jobs.cancelJob,
  retryJob: jobs.retryJob,
};

export const ROUTES: readonly Route[] = ROUTE_TABLE.map((route) => ({
  method: route.method,
  path: route.path,
  public: 'public' in route ? route.public : false,
  handler: HANDLERS[route.id],
}));
