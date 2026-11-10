import { randomUUID } from 'crypto';

import { LIMITS, TERMINAL_JOB_STATUSES } from '@talvio/llm-contracts';

import { answeredContext, firstContext } from './context';
import {
  DEFAULT_ACCOUNT_DAILY_CEILING_MICRO_USD,
  PLAN_LIMITS,
  PRICING_VERSION,
  QuotaExceededError,
  resolveLimits,
  type LimitOverride,
  type UserLimits,
} from '../limits';
import {
  IdempotencyConflictError,
  InvalidCursorError,
  type DocumentRecord,
  type JobRecord,
  type OutboxEvent,
  type QuestionSetRecord,
  type SessionRecord,
  type Store,
} from './types';

/** Seven-day session lifetime and 24-hour incomplete-upload expiry (design §13). */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const CONTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_GRANT_TTL_MS = 5 * 60 * 1000;

export type MemoryStoreOptions = {
  /** Replaces the default plan table, so tests can exercise a plan the service does not issue yet. */
  planLimits?: Record<string, UserLimits>;
  accountDailyCeilingMicroUsd?: number;
};

export type MemoryStore = Store & {
  /** Test and local helpers; not part of the Store interface. */
  testing: {
    setLimitOverride(ownerId: string, override: LimitOverride | null): void;
    setJob(jobId: string, patch: Partial<JobRecord>): void;
    setDocument(documentId: string, patch: Partial<DocumentRecord>): void;
    addQuestionSet(set: Omit<QuestionSetRecord, 'questionSetId'>): QuestionSetRecord;
  };
};

/** In-process store for tests and `sls offline`. Config forbids it outside local and test. */
export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const planLimits = options.planLimits ?? PLAN_LIMITS;
  const accountCeiling =
    options.accountDailyCeilingMicroUsd ?? DEFAULT_ACCOUNT_DAILY_CEILING_MICRO_USD;
  const overrides = new Map<string, LimitOverride>();
  const events: (OutboxEvent & { dispatched: boolean })[] = [];
  const jobs = new Map<string, JobRecord>();
  const documents = new Map<string, DocumentRecord>();
  const sessions = new Map<string, SessionRecord>();
  const questionSets = new Map<string, QuestionSetRecord>();

  const utcDay = (date: Date) => date.toISOString().slice(0, 10);
  const held = (job: JobRecord) => !TERMINAL_JOB_STATUSES.includes(job.status);

  /** Counts the owner's jobs the way the DynamoDB counters do: per UTC admission day and active. */
  const usage = (ownerId: string, day: string) => {
    const mine = [...jobs.values()].filter((job) => job.ownerId === ownerId);
    return {
      jobs: mine.filter((job) => utcDay(job.createdAt) === day).length,
      active: mine.filter(held).length,
      used: mine
        .filter((job) => utcDay(job.createdAt) === day)
        .reduce((sum, job) => sum + job.spendReservedMicroUsd + job.spendCommittedMicroUsd, 0),
    };
  };
  const accountUsed = (day: string) =>
    [...jobs.values()]
      .filter((job) => utcDay(job.createdAt) === day)
      .reduce((sum, job) => sum + job.spendReservedMicroUsd + job.spendCommittedMicroUsd, 0);

  /** Throws when taking one more slot and `reserve` more spend would cross a limit. */
  const limitsFor = (ownerId: string, plan: JobRecord['plan']) =>
    resolveLimits(plan, overrides.get(ownerId) ?? null, planLimits);

  const checkQuota = (
    ownerId: string,
    limits: ReturnType<typeof limitsFor>,
    day: string,
    reserve: number,
    countsAsNewJob: boolean,
  ) => {
    const used = usage(ownerId, day);
    if (countsAsNewJob && used.jobs + 1 > limits.jobsPerDay) {
      throw new QuotaExceededError('jobs_per_day');
    }
    if (used.active + 1 > limits.activeJobs) {
      throw new QuotaExceededError('active_jobs');
    }
    if (used.used + reserve > limits.dailySpendMicroUsd) {
      throw new QuotaExceededError('daily_spend');
    }
    if (accountUsed(day) + reserve > accountCeiling) {
      throw new QuotaExceededError('account_ceiling');
    }
  };

  const findByKey = (ownerId: string, idempotencyKey: string) =>
    [...jobs.values()].find(
      (job) => job.ownerId === ownerId && job.idempotencyKey === idempotencyKey,
    ) ?? null;

  const emit = (type: OutboxEvent['type'], job: JobRecord, now: Date) => {
    events.push({
      eventId: randomUUID(),
      type,
      ownerId: job.ownerId,
      jobId: job.jobId,
      operation: job.operation,
      createdAt: now,
      dispatched: false,
    });
  };

  const owned = <T extends { ownerId: string }>(record: T | undefined, ownerId: string) =>
    record && record.ownerId === ownerId ? record : null;

  return {
    jobs: {
      async findByIdempotencyKey(ownerId, idempotencyKey) {
        return findByKey(ownerId, idempotencyKey);
      },
      async admit({ ownerId, plan, idempotencyKey, requestHash, request, now, deadlineAt }) {
        const existing = findByKey(ownerId, idempotencyKey);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new IdempotencyConflictError();
          }
          return { job: existing, replayed: true };
        }
        const reserve = limitsFor(ownerId, plan).jobBudgetMicroUsd;
        checkQuota(ownerId, limitsFor(ownerId, plan), utcDay(now), reserve, true);
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
          plan,
          budgetCapMicroUsd: reserve,
          spendReservedMicroUsd: reserve,
          spendCommittedMicroUsd: 0,
          pricingVersion: PRICING_VERSION,
          createdAt: now,
          updatedAt: now,
          deadlineAt,
          result: null,
          error: null,
        };
        jobs.set(job.jobId, job);
        emit('job.admitted', job, now);
        return { job, replayed: false };
      },
      async get(ownerId, jobId) {
        return owned(jobs.get(jobId), ownerId);
      },
      async list(ownerId, cursor, limit) {
        const all = [...jobs.values()]
          .filter((job) => job.ownerId === ownerId)
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
        const start = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) : 0;
        if (!Number.isInteger(start) || start < 0) {
          throw new InvalidCursorError();
        }
        const page = all.slice(start, start + limit);
        const next = start + limit < all.length ? String(start + limit) : null;
        return { jobs: page, nextCursor: next ? Buffer.from(next).toString('base64url') : null };
      },
      async cancel(ownerId, jobId, now) {
        const job = owned(jobs.get(jobId), ownerId);
        if (!job || TERMINAL_JOB_STATUSES.includes(job.status)) {
          return job;
        }
        Object.assign(job, {
          status: 'cancelled',
          stage: 'done',
          updatedAt: now,
          spendReservedMicroUsd: 0,
        });
        return job;
      },
      async retry(ownerId, jobId, now) {
        const job = owned(jobs.get(jobId), ownerId);
        if (!job) {
          return null;
        }
        if (held(job)) {
          return job;
        }
        const reserve = job.budgetCapMicroUsd;
        checkQuota(ownerId, limitsFor(ownerId, job.plan), utcDay(job.createdAt), reserve, false);
        Object.assign(job, {
          status: 'queued',
          stage: 'admission',
          error: null,
          spendReservedMicroUsd: reserve,
          updatedAt: now,
        });
        emit('job.retried', job, now);
        return job;
      },
      async delete(ownerId, jobId) {
        return owned(jobs.get(jobId), ownerId) ? jobs.delete(jobId) : false;
      },
    },

    outbox: {
      async pending(limit) {
        return events.filter((event) => !event.dispatched).slice(0, limit);
      },
      async markDispatched(event) {
        const found = events.find((item) => item.eventId === event.eventId);
        if (found) {
          found.dispatched = true;
        }
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
      async complete(ownerId, documentId, now) {
        const document = owned(documents.get(documentId), ownerId);
        if (document?.status === 'awaiting_upload') {
          document.status = 'validating';
          document.expiresAt = new Date(now.getTime() + CONTENT_TTL_MS);
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
          latestContext: firstContext(sessionId, context, now),
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
        session.latestContext = firstContext(sessionId, context, now);
        return session.latestContext;
      },
      async getQuestionSet(ownerId, sessionId, questionSetId) {
        const session = owned(sessions.get(sessionId), ownerId);
        const set = questionSets.get(questionSetId);
        return session && set?.sessionId === sessionId ? set : null;
      },
      async saveQuestionSet(ownerId, set) {
        if (!owned(sessions.get(set.sessionId), ownerId)) {
          return null;
        }
        questionSets.set(set.questionSetId, set);
        return set;
      },
      async addAnswers({ ownerId, sessionId, baseContextRevisionId, answersHash, now }) {
        const session = owned(sessions.get(sessionId), ownerId);
        if (!session) {
          return null;
        }
        if (session.latestContext.contextRevisionId !== baseContextRevisionId) {
          return 'stale';
        }
        session.latestContext = answeredContext(session.latestContext, answersHash, now).context;
        return session.latestContext;
      },
      async delete(ownerId, sessionId) {
        return owned(sessions.get(sessionId), ownerId) ? sessions.delete(sessionId) : false;
      },
    },

    testing: {
      setLimitOverride(ownerId, override) {
        if (override) {
          overrides.set(ownerId, override);
        } else {
          overrides.delete(ownerId);
        }
      },
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
