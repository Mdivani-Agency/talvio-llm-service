import {
  createContextRequestSchema,
  createSessionRequestSchema,
  duplicateIds,
  sessionSchema,
  submitAnswersRequestSchema,
  type JobDescription,
  type SourceSnapshot,
} from '@talvio/llm-contracts';

import { ApiError, notFound } from '@lib/errors';
import { contentHash } from '@lib/hash';
import { IdempotencyConflictError, type ContextInput, type SessionRecord } from '@lib/store';
import { parseWith } from '@lib/validation';

import { userOf, type RouteHandler } from '../types';

function toSession(record: SessionRecord) {
  return sessionSchema.parse({
    sessionId: record.sessionId,
    purpose: record.purpose,
    status: record.status,
    latestContext: record.latestContext,
    questionRoundsUsed: record.questionRoundsUsed,
    questionsIssued: record.questionsIssued,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  });
}

/** Server-computed hashes; clients never supply them. */
function contextInput(source: SourceSnapshot, jobDescription: JobDescription | null): ContextInput {
  const sourceHash = contentHash(source);
  const jobDescriptionHash = jobDescription ? contentHash(jobDescription) : null;
  return {
    source,
    jobDescription,
    sourceHash,
    jobDescriptionHash,
    contextHash: contentHash({ sourceHash, jobDescriptionHash, answerRevisionId: null }),
  };
}

const staleOrMissing = <T>(value: T | 'stale' | null): T => {
  if (value === null) {
    throw notFound();
  }
  if (value === 'stale') {
    throw new ApiError('stale_context');
  }
  return value;
};

export const createSession: RouteHandler = async (request, deps) => {
  const body = parseWith(createSessionRequestSchema, request.body);
  if (body.purpose === 'tailor' && !body.jobDescription) {
    throw new ApiError('invalid_request', {
      issues: [{ path: 'jobDescription', message: 'Required for tailoring.' }],
    });
  }
  try {
    const { session } = await deps.store.sessions.create({
      ownerId: userOf(request),
      clientRequestId: body.clientRequestId,
      requestHash: contentHash(body),
      purpose: body.purpose,
      context: contextInput(body.source, body.jobDescription),
      now: request.now,
    });
    return { status: 201, body: toSession(session) };
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      throw new ApiError('idempotency_conflict');
    }
    throw error;
  }
};

export const getSession: RouteHandler = async (request, deps) => {
  const session = await deps.store.sessions.get(userOf(request), request.params.sessionId ?? '');
  if (!session) {
    throw notFound();
  }
  return { status: 200, body: toSession(session) };
};

export const deleteSession: RouteHandler = async (request, deps) => {
  if (!(await deps.store.sessions.delete(userOf(request), request.params.sessionId ?? ''))) {
    throw notFound();
  }
  return { status: 204 };
};

export const createContext: RouteHandler = async (request, deps) => {
  const ownerId = userOf(request);
  const sessionId = request.params.sessionId ?? '';
  const body = parseWith(createContextRequestSchema, request.body);
  const session = await deps.store.sessions.get(ownerId, sessionId);
  if (!session) {
    throw notFound();
  }
  if (session.purpose === 'tailor' && !body.jobDescription) {
    throw new ApiError('invalid_request', {
      issues: [{ path: 'jobDescription', message: 'Required for tailoring.' }],
    });
  }
  const context = await deps.store.sessions.addContext({
    ownerId,
    sessionId,
    baseContextRevisionId: body.baseContextRevisionId,
    context: contextInput(body.source, body.jobDescription),
    now: request.now,
  });
  return { status: 201, body: staleOrMissing(context) };
};

/** Answers must name questions issued in that set, once each. */
export const submitAnswers: RouteHandler = async (request, deps) => {
  const ownerId = userOf(request);
  const sessionId = request.params.sessionId ?? '';
  const body = parseWith(submitAnswersRequestSchema, request.body);

  const session = await deps.store.sessions.get(ownerId, sessionId);
  const set = await deps.store.sessions.getQuestionSet(ownerId, sessionId, body.questionSetId);
  if (!session || !set) {
    throw notFound();
  }
  // Questions issued for an earlier source or job description cannot be answered any more.
  if (
    set.sourceHash !== session.latestContext.sourceHash ||
    set.jobDescriptionHash !== session.latestContext.jobDescriptionHash
  ) {
    throw new ApiError('stale_context');
  }
  const issued = new Set(set.questions.map((question) => question.id));
  const ids = body.answers.map((answer) => answer.questionId);
  const unknown = ids.filter((id) => !issued.has(id));
  if (unknown.length || duplicateIds(ids).length) {
    throw new ApiError('invalid_request', {
      issues: [{ path: 'answers', message: 'Answer each issued question at most once.' }],
    });
  }

  const context = await deps.store.sessions.addAnswers({
    ownerId,
    sessionId,
    baseContextRevisionId: body.baseContextRevisionId,
    questionSetId: body.questionSetId,
    answers: body.answers,
    answersHash: contentHash({ questionSetId: body.questionSetId, answers: body.answers }),
    now: request.now,
  });
  return { status: 201, body: staleOrMissing(context) };
};
