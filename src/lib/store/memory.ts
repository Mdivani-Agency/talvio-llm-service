import { randomUUID } from 'crypto';

import { LIMITS, TERMINAL_JOB_STATUSES, type ContextRevision } from '@talvio/llm-contracts';

import { contentHash } from '../hash';
import {
  IdempotencyConflictError,
  type ContextInput,
  type DocumentRecord,
  type JobRecord,
  type QuestionSetRecord,
  type SessionRecord,
  type Store,
} from './types';

/** Seven-day session lifetime and 24-hour incomplete-upload expiry (design §13). */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_GRANT_TTL_MS = 5 * 60 * 1000;

export type MemoryStore = Store & {
  /** Test and local helpers; not part of the Store interface. */
  testing: {
    setJob(jobId: string, patch: Partial<JobRecord>): void;
    setDocument(documentId: string, patch: Partial<DocumentRecord>): void;
    addQuestionSet(set: Omit<QuestionSetRecord, 'questionSetId'>): QuestionSetRecord;
  };
};

/** In-process store for tests and `sls offline`. Config forbids it outside local and test. */
export function createMemoryStore(): MemoryStore {
  const jobs = new Map<string, JobRecord>();
  const documents = new Map<string, DocumentRecord>();
  const sessions = new Map<string, SessionRecord>();
  const questionSets = new Map<string, QuestionSetRecord>();

  const owned = <T extends { ownerId: string }>(record: T | undefined, ownerId: string) =>
    record && record.ownerId === ownerId ? record : null;

  const newContext = (sessionId: string, context: ContextInput, now: Date): ContextRevision => ({
    contextRevisionId: randomUUID(),
    sessionId,
    contextHash: context.contextHash,
    sourceHash: context.sourceHash,
    jobDescriptionHash: context.jobDescriptionHash,
    answerRevisionId: null,
    createdAt: now.toISOString(),
  });

  return {
    jobs: {
      async findByIdempotencyKey(ownerId, idempotencyKey) {
        return (
          [...jobs.values()].find(
            (job) => job.ownerId === ownerId && job.idempotencyKey === idempotencyKey,
          ) ?? null
        );
      },
      async admit({ ownerId, idempotencyKey, requestHash, request, now, deadlineAt }) {
        const existing = await this.findByIdempotencyKey(ownerId, idempotencyKey);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new IdempotencyConflictError();
          }
          return { job: existing, replayed: true };
        }
        const session = 'sessionId' in request ? request : null;
        const job: JobRecord = {
          jobId: randomUUID(),
          ownerId,
          operation: request.operation,
          status: 'queued',
          stage: 'admission',
          sessionId: session?.sessionId ?? null,
          contextRevisionId: session?.contextRevisionId ?? null,
          parentJobId: session?.parentJobId ?? null,
          idempotencyKey,
          requestHash,
          createdAt: now,
          updatedAt: now,
          deadlineAt,
          result: null,
          error: null,
        };
        jobs.set(job.jobId, job);
        return { job, replayed: false };
      },
      async get(ownerId, jobId) {
        return owned(jobs.get(jobId), ownerId);
      },
      async list(ownerId, cursor, limit) {
        const all = [...jobs.values()]
          .filter((job) => job.ownerId === ownerId)
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
        const start = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) || 0 : 0;
        const page = all.slice(start, start + limit);
        const next = start + limit < all.length ? String(start + limit) : null;
        return { jobs: page, nextCursor: next ? Buffer.from(next).toString('base64url') : null };
      },
      async cancel(ownerId, jobId, now) {
        const job = owned(jobs.get(jobId), ownerId);
        if (!job || TERMINAL_JOB_STATUSES.includes(job.status)) {
          return job;
        }
        Object.assign(job, { status: 'cancelled', stage: 'done', updatedAt: now });
        return job;
      },
      async retry(ownerId, jobId, now) {
        const job = owned(jobs.get(jobId), ownerId);
        if (!job) {
          return null;
        }
        Object.assign(job, { status: 'queued', stage: 'admission', error: null, updatedAt: now });
        return job;
      },
      async delete(ownerId, jobId) {
        return owned(jobs.get(jobId), ownerId) ? jobs.delete(jobId) : false;
      },
    },

    documents: {
      async create(ownerId, request, now) {
        const document: DocumentRecord = {
          documentId: randomUUID(),
          ownerId,
          status: 'awaiting_upload',
          contentType: request.contentType,
          sizeBytes: request.sizeBytes,
          sha256: request.sha256,
          pageCount: null,
          ocrPages: [],
          createdAt: now,
          expiresAt: new Date(now.getTime() + UPLOAD_TTL_MS),
        };
        documents.set(document.documentId, document);
        return document;
      },
      async get(ownerId, documentId) {
        return owned(documents.get(documentId), ownerId);
      },
      async complete(ownerId, documentId) {
        const document = owned(documents.get(documentId), ownerId);
        if (document?.status === 'awaiting_upload') {
          document.status = 'validating';
        }
        return document;
      },
      async delete(ownerId, documentId) {
        return owned(documents.get(documentId), ownerId) ? documents.delete(documentId) : false;
      },
    },

    uploads: {
      async create(document, now) {
        return {
          method: 'PUT',
          url: `https://uploads.local.invalid/${document.documentId}`,
          headers: { 'content-type': document.contentType },
          expiresAt: new Date(now.getTime() + UPLOAD_GRANT_TTL_MS),
        };
      },
    },

    sessions: {
      async create({ ownerId, clientRequestId, requestHash, purpose, context, now }) {
        const existing = [...sessions.values()].find(
          (session) => session.ownerId === ownerId && session.clientRequestId === clientRequestId,
        );
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new IdempotencyConflictError();
          }
          return { session: existing, replayed: true };
        }
        const sessionId = randomUUID();
        const session: SessionRecord = {
          sessionId,
          ownerId,
          purpose,
          status: 'open',
          clientRequestId,
          requestHash,
          latestContext: newContext(sessionId, context, now),
          questionRoundsUsed: 0,
          questionsIssued: 0,
          createdAt: now,
          expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
        };
        sessions.set(sessionId, session);
        return { session, replayed: false };
      },
      async get(ownerId, sessionId) {
        return owned(sessions.get(sessionId), ownerId);
      },
      async addContext({ ownerId, sessionId, baseContextRevisionId, context, now }) {
        const session = owned(sessions.get(sessionId), ownerId);
        if (!session) {
          return null;
        }
        if (session.latestContext.contextRevisionId !== baseContextRevisionId) {
          return 'stale';
        }
        session.latestContext = newContext(sessionId, context, now);
        return session.latestContext;
      },
      async getQuestionSet(ownerId, sessionId, questionSetId) {
        const session = owned(sessions.get(sessionId), ownerId);
        const set = questionSets.get(questionSetId);
        return session && set?.sessionId === sessionId ? set : null;
      },
      async addAnswers({ ownerId, sessionId, baseContextRevisionId, answersHash, now }) {
        const session = owned(sessions.get(sessionId), ownerId);
        if (!session) {
          return null;
        }
        if (session.latestContext.contextRevisionId !== baseContextRevisionId) {
          return 'stale';
        }
        session.latestContext = {
          ...session.latestContext,
          contextRevisionId: randomUUID(),
          contextHash: contentHash({ previous: session.latestContext.contextHash, answersHash }),
          answerRevisionId: randomUUID(),
          createdAt: now.toISOString(),
        };
        return session.latestContext;
      },
      async delete(ownerId, sessionId) {
        return owned(sessions.get(sessionId), ownerId) ? sessions.delete(sessionId) : false;
      },
    },

    testing: {
      setJob(jobId, patch) {
        const job = jobs.get(jobId);
        if (job) {
          Object.assign(job, patch);
        }
      },
      setDocument(documentId, patch) {
        const document = documents.get(documentId);
        if (document) {
          Object.assign(document, patch);
        }
      },
      addQuestionSet(set) {
        if (set.questions.length > LIMITS.questionsPerSet) {
          throw new Error('too many questions');
        }
        const record = { ...set, questionSetId: randomUUID() };
        questionSets.set(record.questionSetId, record);
        return record;
      },
    },
  };
}
