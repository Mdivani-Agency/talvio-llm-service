import {
  LIMITS,
  RETRYABLE_JOB_ERRORS,
  createJobRequestSchema,
  idempotencyKeySchema,
  jobSchema,
  type CreateJobRequest,
  type Job,
} from '@talvio/llm-contracts';

import { ApiError, notFound } from '@lib/errors';
import { contentHash } from '@lib/hash';
import { IdempotencyConflictError, type JobRecord } from '@lib/store';
import { parseWith } from '@lib/validation';

import { userOf, type Deps, type RouteHandler } from '../types';

/** First poll delay suggested to clients; they back off to about five seconds. */
const POLL_AFTER_MS = 1_000;
const LIST_LIMIT = 20;

/** Maps a stored job to the contract and validates it, so a bad record never leaves the API. */
export function toJob(record: JobRecord): Job {
  const terminal = ['succeeded', 'failed', 'cancelled', 'expired'].includes(record.status);
  return jobSchema.parse({
    jobId: record.jobId,
    operation: record.operation,
    status: record.status,
    stage: record.stage,
    sessionId: record.sessionId,
    contextRevisionId: record.contextRevisionId,
    parentJobId: record.parentJobId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    deadlineAt: record.deadlineAt.toISOString(),
    pollAfterMs: terminal ? null : POLL_AFTER_MS,
    result: record.result,
    error: record.error,
  });
}

const accepted = (job: JobRecord, replayed: boolean) => ({
  status: 202,
  body: {
    jobId: job.jobId,
    status: job.status,
    statusUrl: `/llm/v1/jobs/${job.jobId}`,
    pollAfterMs: POLL_AFTER_MS,
    replayed,
  },
});

/** A dependency on an earlier job must be the caller's and belong to the same session. */
async function checkDependency(
  deps: Deps,
  ownerId: string,
  jobId: string,
  sessionId: string,
  field: string,
  operation?: JobRecord['operation'],
) {
  const job = await deps.store.jobs.get(ownerId, jobId);
  if (!job) {
    throw notFound();
  }
  if (job.sessionId !== sessionId || (operation && job.operation !== operation)) {
    throw new ApiError('invalid_request', {
      issues: [{ path: field, message: 'Must be a compatible job in the same session.' }],
    });
  }
}

/** Ownership and freshness of everything the request refers to. */
async function checkReferences(deps: Deps, ownerId: string, request: CreateJobRequest) {
  if (request.operation === 'parse_document') {
    if (request.input.kind === 'document') {
      const document = await deps.store.documents.get(ownerId, request.input.documentId);
      if (!document) {
        throw notFound();
      }
      if (document.status !== 'ready') {
        throw new ApiError('unusable_document', { message: 'This document is not ready yet.' });
      }
    }
    return;
  }

  const session = await deps.store.sessions.get(ownerId, request.sessionId);
  if (!session) {
    throw notFound();
  }
  if (
    session.status !== 'open' ||
    session.latestContext.contextRevisionId !== request.contextRevisionId
  ) {
    throw new ApiError('stale_context');
  }
  if (request.parentJobId) {
    await checkDependency(deps, ownerId, request.parentJobId, request.sessionId, 'parentJobId');
  }
  if (request.operation === 'generate_questions' && request.input.analysisJobId) {
    await checkDependency(
      deps,
      ownerId,
      request.input.analysisJobId,
      request.sessionId,
      'input.analysisJobId',
      'analyze_resume',
    );
  }
}

export const createJob: RouteHandler = async (request, deps) => {
  const ownerId = userOf(request);
  const key = request.headers['idempotency-key'];
  if (!key) {
    throw new ApiError('idempotency_key_required');
  }
  if (!idempotencyKeySchema.safeParse(key).success) {
    throw new ApiError('invalid_request', {
      issues: [{ path: 'Idempotency-Key', message: 'Wrong format.' }],
    });
  }
  const body = parseWith(createJobRequestSchema, request.body);
  if (body.clientRequestId !== key) {
    throw new ApiError('invalid_request', {
      issues: [{ path: 'clientRequestId', message: 'Must equal the Idempotency-Key header.' }],
    });
  }

  // Replays are answered before any other check or cost.
  const requestHash = contentHash(body);
  const existing = await deps.store.jobs.findByIdempotencyKey(ownerId, key);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new ApiError('idempotency_conflict');
    }
    return accepted(existing, true);
  }

  await checkReferences(deps, ownerId, body);

  try {
    const { job, replayed } = await deps.store.jobs.admit({
      ownerId,
      idempotencyKey: key,
      requestHash,
      request: body,
      now: request.now,
      deadlineAt: new Date(request.now.getTime() + LIMITS.jobDeadlineMs),
    });
    deps.logger.log('info', {
      event: 'job_admitted',
      correlationId: request.correlationId,
      jobId: job.jobId,
      operation: job.operation,
      replayed,
    });
    return accepted(job, replayed);
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      throw new ApiError('idempotency_conflict');
    }
    throw error;
  }
};

export const getJob: RouteHandler = async (request, deps) => {
  const job = await deps.store.jobs.get(userOf(request), request.params.jobId ?? '');
  if (!job) {
    throw notFound();
  }
  return { status: 200, body: toJob(job) };
};

export const listJobs: RouteHandler = async (request, deps) => {
  const cursor = request.query.cursor ?? null;
  if (cursor !== null && !/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) {
    throw new ApiError('invalid_request', {
      issues: [{ path: 'cursor', message: 'Wrong format.' }],
    });
  }
  const page = await deps.store.jobs.list(userOf(request), cursor, LIST_LIMIT);
  return { status: 200, body: { jobs: page.jobs.map(toJob), nextCursor: page.nextCursor } };
};

export const cancelJob: RouteHandler = async (request, deps) => {
  const job = await deps.store.jobs.cancel(
    userOf(request),
    request.params.jobId ?? '',
    request.now,
  );
  if (!job) {
    throw notFound();
  }
  return { status: 200, body: toJob(job) };
};

export const retryJob: RouteHandler = async (request, deps) => {
  const ownerId = userOf(request);
  const jobId = request.params.jobId ?? '';
  const job = await deps.store.jobs.get(ownerId, jobId);
  if (!job) {
    throw notFound();
  }
  const eligible =
    job.status === 'failed' &&
    job.error !== null &&
    RETRYABLE_JOB_ERRORS.includes(job.error.code) &&
    request.now < job.deadlineAt;
  if (!eligible) {
    throw new ApiError('invalid_retry');
  }
  const retried = await deps.store.jobs.retry(ownerId, jobId, request.now);
  if (!retried) {
    throw notFound();
  }
  return accepted(retried, false);
};

export const deleteJob: RouteHandler = async (request, deps) => {
  if (!(await deps.store.jobs.delete(userOf(request), request.params.jobId ?? ''))) {
    throw notFound();
  }
  return { status: 204 };
};
