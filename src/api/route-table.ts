/**
 * Every route of /llm/v1, without handlers so serverless.ts can import it. One API Gateway
 * event is created per entry; a route that is not listed is not reachable. Paths are relative
 * to the `llm` base path mapping. Only health is public.
 */
export const ROUTE_TABLE = [
  { id: 'health', method: 'GET', path: '/v1/health', public: true },
  { id: 'createDocument', method: 'POST', path: '/v1/documents' },
  { id: 'getDocument', method: 'GET', path: '/v1/documents/{documentId}' },
  { id: 'deleteDocument', method: 'DELETE', path: '/v1/documents/{documentId}' },
  { id: 'completeDocument', method: 'POST', path: '/v1/documents/{documentId}/complete' },
  { id: 'createSession', method: 'POST', path: '/v1/sessions' },
  { id: 'getSession', method: 'GET', path: '/v1/sessions/{sessionId}' },
  { id: 'deleteSession', method: 'DELETE', path: '/v1/sessions/{sessionId}' },
  { id: 'createContext', method: 'POST', path: '/v1/sessions/{sessionId}/contexts' },
  { id: 'submitAnswers', method: 'POST', path: '/v1/sessions/{sessionId}/answers' },
  { id: 'createJob', method: 'POST', path: '/v1/jobs' },
  { id: 'listJobs', method: 'GET', path: '/v1/jobs' },
  { id: 'getJob', method: 'GET', path: '/v1/jobs/{jobId}' },
  { id: 'deleteJob', method: 'DELETE', path: '/v1/jobs/{jobId}' },
  { id: 'cancelJob', method: 'POST', path: '/v1/jobs/{jobId}/cancel' },
  { id: 'retryJob', method: 'POST', path: '/v1/jobs/{jobId}/retry' },
] as const satisfies readonly {
  id: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  public?: boolean;
}[];

export type RouteId = (typeof ROUTE_TABLE)[number]['id'];
