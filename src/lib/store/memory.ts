import { randomUUID } from 'crypto';

import { LIMITS, TERMINAL_JOB_STATUSES } from '@talvio/llm-contracts';

import { DISPATCH_GRACE_MS, MAX_STEP_ATTEMPTS, abandonable } from '../execution';
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
  type JobStage,
  type Lease,
  type OutboxEvent,
  type QuestionSetRecord,
  type SessionRecord,
  type Store,
} from './types';

/** Seven-day session lifetime and 24-hour incomplete-upload expiry (design §13). */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const CONTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** When each live job is next looked at by the reconciler (the DynamoDB store keeps this as a sparse index). */
  const checks = new Map<string, Date>();
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

  const emit = (type: OutboxEvent['type'], job: JobRecord, now: Date, availableAt = now) => {
    const event = {
      eventId: randomUUID(),
      type,
      ownerId: job.ownerId,
      jobId: job.jobId,
      operation: job.operation,
      pipelineReleaseId: job.exec.pipelineReleaseId,
      createdAt: now,
      availableAt,
      dispatched: false,
    };
    events.push(event);
    return event;
  };

  const earliest = (...dates: Date[]) => new Date(Math.min(...dates.map((d) => d.getTime())));
  /** Next reconciler look: after `after`, never later than the deadline. */
  const watch = (job: JobRecord, after: Date) => {
    if (held(job)) {
      checks.set(job.jobId, earliest(after, job.deadlineAt));
    } else {
      checks.delete(job.jobId);
    }
  };

  const snapshot = (job: JobRecord): JobRecord => ({
    ...job,
    exec: {
      ...job.exec,
      stepAttempts: { ...job.exec.stepAttempts },
      checkpoints: Object.fromEntries(
        Object.entries(job.exec.checkpoints).map(([step, refs]) => [step, { ...refs }]),
      ),
    },
  });

  /** Ends a job in `status`, keeping what it spent and releasing the rest of its reservation. */
  const settle = (
    job: JobRecord,
    status: JobRecord['status'],
    now: Date,
    fields: Partial<JobRecord>,
    committed = job.spendCommittedMicroUsd,
  ) => {
    Object.assign(job, fields, {
      status,
      stage: 'done',
      updatedAt: now,
      spendReservedMicroUsd: 0,
      spendCommittedMicroUsd: Math.min(committed, job.budgetCapMicroUsd),
    });
    job.exec.fence += 1;
    job.exec.leaseExpiresAt = null;
    job.exec.availableAt = null;
    job.exec.externalRef = null;
    watch(job, now);
  };

  const deadlineError = (job: JobRecord) => ({
    code: 'deadline_exceeded' as const,
    message: 'The job did not finish before its deadline.',
    retryable: false,
    correlationId: job.jobId,
  });

  /** The job a lease still belongs to: same owner, still running, fence unchanged. */
  const leased = (lease: Lease) => {
    const job = owned(jobs.get(lease.jobId), lease.ownerId);
    return job && job.status === 'running' && job.exec.fence === lease.fence ? job : null;
  };

  const owned = <T extends { ownerId: string }>(record: T | undefined, ownerId: string) =>
    record && record.ownerId === ownerId ? record : null;

  return {
    jobs: {
      async findByIdempotencyKey(ownerId, idempotencyKey) {
        return findByKey(ownerId, idempotencyKey);
      },
      async admit({
        ownerId,
        plan,
        pipelineReleaseId,
        idempotencyKey,
        requestHash,
        request,
        now,
        deadlineAt,
      }) {
        const existing = findByKey(ownerId, idempotencyKey);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new IdempotencyConflictError();
          }
          return { job: existing, replayed: true, event: null };
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
          exec: {
            pipelineReleaseId,
            fence: 0,
            leaseExpiresAt: null,
            availableAt: null,
            stepAttempts: {},
            checkpoints: {},
            externalRef: null,
          },
        };
        jobs.set(job.jobId, job);
        const event = emit('job.admitted', job, now);
        watch(job, new Date(now.getTime() + DISPATCH_GRACE_MS));
        return { job, replayed: false, event };
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
        settle(job, 'cancelled', now, {});
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
        job.exec.stepAttempts = {};
        emit('job.retried', job, now);
        watch(job, new Date(now.getTime() + DISPATCH_GRACE_MS));
        return job;
      },
      async delete(ownerId, jobId) {
        checks.delete(jobId);
        return owned(jobs.get(jobId), ownerId) ? jobs.delete(jobId) : false;
      },
    },

    outbox: {
      async pending(limit, now) {
        return events
          .filter((event) => !event.dispatched && event.availableAt <= now)
          .slice(0, limit)
          .map(({ dispatched: _dispatched, ...event }) => event);
      },
      async markDispatched(event) {
        const found = events.find((item) => item.eventId === event.eventId);
        if (found) {
          found.dispatched = true;
        }
      },
    },

    execution: {
      async claim(ownerId, jobId, now, leaseMs) {
        const job = owned(jobs.get(jobId), ownerId);
        if (!job) return { kind: 'skipped', reason: 'missing' };
        if (!held(job)) return { kind: 'skipped', reason: 'terminal' };
        if (now >= job.deadlineAt) {
          settle(job, 'expired', now, { error: deadlineError(job) });
          return { kind: 'skipped', reason: 'expired' };
        }
        if (job.status === 'waiting_external') return { kind: 'skipped', reason: 'waiting' };
        if (job.status === 'running' && job.exec.leaseExpiresAt && job.exec.leaseExpiresAt > now) {
          return { kind: 'skipped', reason: 'leased' };
        }
        if (job.status === 'retry_wait' && job.exec.availableAt && job.exec.availableAt > now) {
          return { kind: 'skipped', reason: 'not_due' };
        }
        // A lapsed lease means a worker died mid-step: that counts as an attempt.
        if (job.status === 'running') {
          const used = (job.exec.stepAttempts[job.stage] ?? 0) + 1;
          if (used >= MAX_STEP_ATTEMPTS) {
            settle(job, 'failed', now, {
              error: {
                code: 'internal_error',
                message: 'The job stopped unexpectedly more than once.',
                retryable: true,
                correlationId: job.jobId,
              },
            });
            return { kind: 'skipped', reason: 'terminal' };
          }
          job.exec.stepAttempts[job.stage] = used;
        }
        const expiresAt = new Date(now.getTime() + leaseMs);
        job.status = 'running';
        job.updatedAt = now;
        job.exec.fence += 1;
        job.exec.leaseExpiresAt = expiresAt;
        job.exec.availableAt = null;
        watch(job, expiresAt);
        return {
          kind: 'claimed',
          job: snapshot(job),
          lease: { ownerId, jobId, fence: job.exec.fence, expiresAt },
        };
      },
      async extend(lease, now, leaseMs) {
        const job = leased(lease);
        if (!job) return null;
        const expiresAt = new Date(now.getTime() + leaseMs);
        job.exec.leaseExpiresAt = expiresAt;
        watch(job, expiresAt);
        return { ...lease, expiresAt };
      },
      async checkpoint(lease, step: JobStage, refs, now) {
        const job = leased(lease);
        if (!job) return 'stale';
        job.stage = step;
        job.updatedAt = now;
        job.exec.checkpoints[step] = { ...job.exec.checkpoints[step], ...refs };
        return 'applied';
      },
      async succeed(lease, result, settlement, now) {
        const job = owned(jobs.get(lease.jobId), lease.ownerId);
        if (job?.status === 'succeeded' && job.exec.fence === lease.fence + 1) return 'applied';
        const live = leased(lease);
        if (!live) return 'stale';
        if (now >= live.deadlineAt) {
          // Finished after the deadline: nothing is published; the job expires and settles.
          settle(live, 'expired', now, { error: deadlineError(live) });
          return 'stale';
        }
        settle(live, 'succeeded', now, { result, error: null }, settlement.spendCommittedMicroUsd);
        return 'applied';
      },
      async fail(lease, error, settlement, now) {
        const job = owned(jobs.get(lease.jobId), lease.ownerId);
        if (job?.status === 'failed' && job.exec.fence === lease.fence + 1) return 'applied';
        const live = leased(lease);
        if (!live) return 'stale';
        settle(live, 'failed', now, { error }, settlement.spendCommittedMicroUsd);
        return 'applied';
      },
      async retryLater(lease, step: JobStage, availableAt, now) {
        const job = leased(lease);
        if (!job) return 'stale';
        job.status = 'retry_wait';
        job.stage = step;
        job.updatedAt = now;
        job.exec.fence += 1;
        job.exec.leaseExpiresAt = null;
        job.exec.availableAt = availableAt;
        job.exec.stepAttempts[step] = (job.exec.stepAttempts[step] ?? 0) + 1;
        emit('job.retry', job, now, availableAt);
        watch(job, new Date(availableAt.getTime() + DISPATCH_GRACE_MS));
        return 'applied';
      },
      async waitExternal(lease, ref, now) {
        const job = leased(lease);
        if (!job) return 'stale';
        job.status = 'waiting_external';
        job.updatedAt = now;
        job.exec.fence += 1;
        job.exec.leaseExpiresAt = null;
        job.exec.externalRef = ref;
        watch(job, job.deadlineAt);
        return 'applied';
      },
      async resume(ownerId, jobId, ref, now) {
        const job = owned(jobs.get(jobId), ownerId);
        if (!job || job.status !== 'waiting_external' || job.exec.externalRef !== ref) {
          return false;
        }
        job.status = 'queued';
        job.updatedAt = now;
        job.exec.externalRef = null;
        emit('job.resume', job, now);
        watch(job, new Date(now.getTime() + DISPATCH_GRACE_MS));
        return true;
      },
      async abandon(ownerId, jobId, error, now) {
        const job = owned(jobs.get(jobId), ownerId);
        if (!job || !held(job)) return 'stale';
        const view = {
          status: job.status,
          leaseExpiresAt: job.exec.leaseExpiresAt,
          availableAt: job.exec.availableAt,
        };
        if (!abandonable(view, now)) {
          return 'stale';
        }
        settle(job, 'failed', now, { error });
        return 'applied';
      },
      async due(now, limit) {
        return [...checks.entries()]
          .filter(([, at]) => at <= now)
          .sort((left, right) => left[1].getTime() - right[1].getTime())
          .slice(0, limit)
          .flatMap(([jobId]) => {
            const job = jobs.get(jobId);
            return job ? [{ ownerId: job.ownerId, jobId }] : [];
          });
      },
      async reconcile(ownerId, jobId, now) {
        const job = owned(jobs.get(jobId), ownerId);
        if (!job) return 'missing';
        if (!held(job)) {
          checks.delete(jobId);
          return 'settled';
        }
        if (now >= job.deadlineAt) {
          settle(job, 'expired', now, { error: deadlineError(job) });
          return 'expired';
        }
        if (job.status !== 'waiting_external') {
          emit('job.requeue', job, now);
        }
        watch(job, new Date(now.getTime() + DISPATCH_GRACE_MS));
        return 'requeued';
      },
    },

    documents: {
      async create(ownerId, request, objectKey, now) {
        const document: DocumentRecord = {
          documentId: randomUUID(),
          ownerId,
          status: 'awaiting_upload',
          contentType: request.contentType,
          sizeBytes: request.sizeBytes,
          sha256: request.sha256,
          objectKey,
          objectVersionId: null,
          pageCount: null,
          ocrPages: [],
          rejectionCode: null,
          warnings: [],
          artifact: null,
          ocr: null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + UPLOAD_TTL_MS),
        };
        documents.set(document.documentId, document);
        return { ...document };
      },
      async get(ownerId, documentId) {
        const document = owned(documents.get(documentId), ownerId);
        return document ? { ...document } : null;
      },
      async complete(ownerId, documentId, pin, now) {
        const document = owned(documents.get(documentId), ownerId);
        if (!document) return null;
        if (document.status !== 'awaiting_upload')
          return { document: { ...document }, event: null };
        document.status = 'validating';
        document.objectVersionId = pin.versionId;
        document.expiresAt = new Date(now.getTime() + CONTENT_TTL_MS);
        const event = {
          eventId: randomUUID(),
          type: 'document.validate' as const,
          ownerId,
          jobId: documentId,
          operation: null,
          /** Document work is not pinned: it goes to the current release's queue. */
          pipelineReleaseId: 'current',
          createdAt: now,
          availableAt: now,
          dispatched: false,
        };
        events.push(event);
        const { dispatched: _dispatched, ...published } = event;
        return { document: { ...document }, event: published };
      },
      async beginOcr(ownerId, documentId, ocr) {
        const document = owned(documents.get(documentId), ownerId);
        if (!document || document.status !== 'validating' || document.ocr) return false;
        document.ocr = {
          state: 'starting',
          clientToken: ocr.clientToken,
          textractJobId: null,
          pages: ocr.pages,
        };
        return true;
      },
      async recordOcrJob(ownerId, documentId, clientToken, textractJobId) {
        const document = owned(documents.get(documentId), ownerId);
        if (
          !document ||
          document.status !== 'validating' ||
          document.ocr?.state !== 'starting' ||
          document.ocr.clientToken !== clientToken
        ) {
          return false;
        }
        document.ocr = { ...document.ocr, state: 'started', textractJobId };
        return true;
      },
      async finish(ownerId, documentId, outcome) {
        const document = owned(documents.get(documentId), ownerId);
        if (!document || document.status !== 'validating') return null;
        document.warnings = outcome.warnings;
        if (outcome.kind === 'ready') {
          document.status = 'ready';
          document.pageCount = outcome.pageCount;
          document.ocrPages = outcome.ocrPages;
          document.artifact = outcome.artifact;
        } else {
          document.status = 'rejected';
          document.rejectionCode = outcome.code;
        }
        return { ...document };
      },
      async delete(ownerId, documentId) {
        const document = owned(documents.get(documentId), ownerId);
        if (!document) return null;
        documents.delete(documentId);
        return { ...document };
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
