import type {
  Answer,
  ContextRevision,
  CreateDocumentRequest,
  CreateJobRequest,
  DocumentStatus,
  JobError,
  JobStatus,
  JobDescription,
  Operation,
  Question,
  SourceSnapshot,
} from '@talvio/llm-contracts';

import type { Plan } from '../plans';

/*
 * Persistence boundary of the API. Every read and write is scoped by `ownerId`: a record owned
 * by someone else is indistinguishable from a missing one, so ownership cannot be skipped by a
 * handler. The DynamoDB implementation (src/lib/store/dynamo; tables owned by Terraform) and the
 * memory store used by unit tests implement the same interfaces.
 */

export type JobStage =
  | 'admission'
  | 'extraction'
  | 'ocr'
  | 'safeguard'
  | 'inference'
  | 'validation'
  | 'publishing'
  | 'done';

/** Bookkeeping the executor keeps on a job. Content-free: counters, ids and times only. */
export type JobExecution = {
  /** Pipeline release that admitted the job; its queue and executables finish it. */
  pipelineReleaseId: string;
  /** Raised by every claim. A worker may write only while its fence is still the job's. */
  fence: number;
  leaseExpiresAt: Date | null;
  /** When a job in retry_wait may run again. */
  availableAt: Date | null;
  /** Application attempts used per step; at most MAX_STEP_ATTEMPTS each. */
  stepAttempts: Record<string, number>;
  /** Provider operation ids (model request, OCR job) per step, so a redelivery resumes instead of repeating. */
  checkpoints: Record<string, Record<string, string>>;
  /** Identifier of the external operation a waiting_external job is parked on. */
  externalRef: string | null;
};

export type JobRecord = {
  jobId: string;
  ownerId: string;
  operation: Operation;
  status: JobStatus;
  stage: JobStage;
  sessionId: string | null;
  contextRevisionId: string | null;
  parentJobId: string | null;
  idempotencyKey: string;
  /** Hash of the canonical admitted request; replays must match it. */
  requestHash: string;
  /** Plan the job was admitted under; retries resolve their limits from it. */
  plan: Plan;
  /** Hard cap for this job and the part of it still reserved or already spent (micro-USD). */
  budgetCapMicroUsd: number;
  spendReservedMicroUsd: number;
  spendCommittedMicroUsd: number;
  pricingVersion: string;
  createdAt: Date;
  updatedAt: Date;
  deadlineAt: Date;
  /** The published result envelope; validated against the contract before it is returned. */
  result: unknown | null;
  error: JobError | null;
  exec: JobExecution;
};

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key reused with a different request');
    this.name = 'IdempotencyConflictError';
  }
}

/** The opaque list cursor was not produced by this store for this user. */
export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

export type AdmitJobInput = {
  ownerId: string;
  plan: Plan;
  /** Release the job is pinned to; it runs on that release's queue. */
  pipelineReleaseId: string;
  idempotencyKey: string;
  requestHash: string;
  request: CreateJobRequest;
  now: Date;
  deadlineAt: Date;
};

export interface JobStore {
  findByIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<JobRecord | null>;
  /**
   * Atomically creates the job, its quota and spend reservation and its outbox event, or none
   * of them. Returns the existing job for a replay with the same hash (a replay consumes no
   * quota), throws IdempotencyConflictError for the same key with a different hash and
   * QuotaExceededError when a limit would be crossed.
   */
  admit(
    input: AdmitJobInput,
  ): Promise<{ job: JobRecord; replayed: boolean; event: OutboxEvent | null }>;
  get(ownerId: string, jobId: string): Promise<JobRecord | null>;
  list(
    ownerId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ jobs: JobRecord[]; nextCursor: string | null }>;
  /** Moves a non-terminal job to cancelled and releases its slot and reservation; a terminal job is returned unchanged. */
  cancel(ownerId: string, jobId: string, now: Date): Promise<JobRecord | null>;
  /**
   * Requeues a failed job, taking an active slot and a new reservation (QuotaExceededError when
   * a limit would be crossed). Eligibility is checked by the caller.
   */
  retry(ownerId: string, jobId: string, now: Date): Promise<JobRecord | null>;
  /** Removes the job, its result and its idempotency record, releasing a held slot and reservation. */
  delete(ownerId: string, jobId: string): Promise<boolean>;
}

export type OutboxEventType =
  | 'document.validate'
  | 'document.ocr_done'
  | 'job.admitted'
  | 'job.retried'
  | 'job.requeue'
  | 'job.retry'
  | 'job.resume';

export type OutboxEvent = {
  eventId: string;
  type: OutboxEventType;
  ownerId: string;
  /** The job; for `document.*` events the document id. */
  jobId: string;
  /** Null for document events. */
  operation: Operation | null;
  pipelineReleaseId: string;
  createdAt: Date;
  /** Not dispatched before this time (retry backoff). */
  availableAt: Date;
};

/** Events written with the job's state change in one transaction; the dispatcher hands them to the work queues. */
export interface OutboxStore {
  /** Undispatched events that are due at `now`, oldest first. */
  pending(limit: number, now: Date): Promise<OutboxEvent[]>;
  markDispatched(event: OutboxEvent, now: Date): Promise<void>;
}

/** Proof of a claim. Every write the worker makes carries it and fails once the fence has moved on. */
export type Lease = {
  ownerId: string;
  jobId: string;
  fence: number;
  expiresAt: Date;
};

export type SkipReason = 'missing' | 'terminal' | 'leased' | 'not_due' | 'waiting' | 'expired';

export type ClaimResult =
  | { kind: 'claimed'; job: JobRecord; lease: Lease }
  | { kind: 'skipped'; reason: SkipReason };

/** `stale`: the lease is no longer the job's (cancelled, deleted, expired or claimed by a newer worker). */
export type WriteResult = 'applied' | 'stale';

export type Settlement = {
  /** Actual spend to keep, in micro-USD; the rest of the reservation is released. */
  spendCommittedMicroUsd: number;
};

export type ReconcileResult = 'expired' | 'requeued' | 'settled' | 'missing';

/**
 * State transitions of the executor. Each is one conditional write (or transaction) guarded by the
 * lease, so duplicate delivery, crashes and late workers cannot publish twice or over a newer lease.
 * None of them is held open across a model or OCR call.
 */
export interface ExecutionStore {
  /** Takes the lease when the job is runnable, expiring it instead when its deadline has passed. */
  claim(ownerId: string, jobId: string, now: Date, leaseMs: number): Promise<ClaimResult>;
  extend(lease: Lease, now: Date, leaseMs: number): Promise<Lease | null>;
  /** Remembers provider ids for a step and moves the job's visible stage to it. */
  checkpoint(
    lease: Lease,
    step: JobStage,
    refs: Record<string, string>,
    now: Date,
  ): Promise<WriteResult>;
  /** Publishes the result and settles quota. A repeat by the same lease is applied again, not duplicated. */
  succeed(lease: Lease, result: unknown, settlement: Settlement, now: Date): Promise<WriteResult>;
  fail(lease: Lease, error: JobError, settlement: Settlement, now: Date): Promise<WriteResult>;
  /** retry_wait until `availableAt`, counting one attempt against `step`. */
  retryLater(lease: Lease, step: JobStage, availableAt: Date, now: Date): Promise<WriteResult>;
  /** waiting_external: gives up the lease so no worker stays open for a long OCR or user wait. */
  waitExternal(lease: Lease, ref: string, now: Date): Promise<WriteResult>;
  /** An external completion wakes the job parked on `ref`; false when nothing was waiting on it. */
  resume(ownerId: string, jobId: string, ref: string, now: Date): Promise<boolean>;
  /** Ends a non-terminal job that a dead letter or an operator found stuck. */
  abandon(ownerId: string, jobId: string, error: JobError, now: Date): Promise<WriteResult>;
  /** Jobs whose next check is due: expired leases, undelivered work, deadlines. */
  due(now: Date, limit: number): Promise<{ ownerId: string; jobId: string }[]>;
  /** Expires the job when past its deadline, else republishes its work. */
  reconcile(ownerId: string, jobId: string, now: Date): Promise<ReconcileResult>;
}

export type DocumentRejection =
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'unusable_document'
  | 'checksum_mismatch';

export type DocumentWarning = { code: string; message: string };

/** The extracted text, stored privately in the artifacts bucket and pinned by version and hash. */
export type DocumentArtifact = {
  key: string;
  versionId: string | null;
  sha256: string;
  chars: number;
  extractorVersion: string;
  method: 'docx' | 'ocr';
};

/** Progress of an asynchronous text detection, so a redelivered message resumes instead of paying again. */
export type DocumentOcr = {
  state: 'starting' | 'started';
  /** Stable idempotency token for the provider call; reusing it returns the same operation. */
  clientToken: string;
  /** Provider job id, set once the operation started. */
  textractJobId: string | null;
  pages: number;
};

export type DocumentRecord = {
  documentId: string;
  ownerId: string;
  status: DocumentStatus;
  contentType: CreateDocumentRequest['contentType'];
  sizeBytes: number;
  sha256: string;
  /** Quarantine key of the upload: `pending/<owner>/<random>`. */
  objectKey: string;
  /** The object version accepted at completion; later replacements are ignored. */
  objectVersionId: string | null;
  pageCount: number | null;
  ocrPages: number[];
  rejectionCode: DocumentRejection | null;
  warnings: DocumentWarning[];
  artifact: DocumentArtifact | null;
  ocr: DocumentOcr | null;
  createdAt: Date;
  expiresAt: Date;
};

export type DocumentOutcome =
  | {
      kind: 'ready';
      pageCount: number | null;
      ocrPages: number[];
      warnings: DocumentWarning[];
      artifact: DocumentArtifact;
    }
  | { kind: 'rejected'; code: DocumentRejection; warnings: DocumentWarning[] };

export type UploadGrant = {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
};

export interface DocumentStore {
  create(
    ownerId: string,
    request: CreateDocumentRequest,
    objectKey: string,
    now: Date,
  ): Promise<DocumentRecord>;
  get(ownerId: string, documentId: string): Promise<DocumentRecord | null>;
  /**
   * awaiting_upload → validating, pinning the object version, with a `document.validate` event in
   * the same write. Any other state is returned unchanged with no event.
   */
  complete(
    ownerId: string,
    documentId: string,
    pin: { versionId: string | null },
    now: Date,
  ): Promise<{ document: DocumentRecord; event: OutboxEvent | null } | null>;
  /** Records the intent to start OCR (validating, none started yet). False when not applicable. */
  beginOcr(
    ownerId: string,
    documentId: string,
    ocr: { clientToken: string; pages: number },
  ): Promise<boolean>;
  /** Records the provider job id for the token that began it. False when stale. */
  recordOcrJob(
    ownerId: string,
    documentId: string,
    clientToken: string,
    textractJobId: string,
  ): Promise<boolean>;
  /** validating → ready or rejected. A document that was deleted or already finished returns null. */
  finish(
    ownerId: string,
    documentId: string,
    outcome: DocumentOutcome,
    now: Date,
  ): Promise<DocumentRecord | null>;
  /** Removes the record and returns it, so its objects can be cleaned up. Null when absent. */
  delete(ownerId: string, documentId: string): Promise<DocumentRecord | null>;
}

export type SessionRecord = {
  sessionId: string;
  ownerId: string;
  purpose: 'improve' | 'tailor';
  status: 'open' | 'closed' | 'expired' | 'deleted';
  clientRequestId: string;
  requestHash: string;
  latestContext: ContextRevision;
  questionRoundsUsed: number;
  questionsIssued: number;
  createdAt: Date;
  expiresAt: Date;
};

export type ContextInput = {
  source: SourceSnapshot;
  jobDescription: JobDescription | null;
  sourceHash: string;
  jobDescriptionHash: string | null;
  contextHash: string;
};

export type QuestionSetRecord = {
  questionSetId: string;
  sessionId: string;
  round: number;
  questions: Question[];
  /** The source and job description the questions were issued for. */
  sourceHash: string;
  jobDescriptionHash: string | null;
};

export interface SessionStore {
  /** Creates the session and its first context, or returns the one made with this key. */
  create(input: {
    ownerId: string;
    clientRequestId: string;
    requestHash: string;
    purpose: 'improve' | 'tailor';
    context: ContextInput;
    now: Date;
  }): Promise<{ session: SessionRecord; replayed: boolean }>;
  get(ownerId: string, sessionId: string): Promise<SessionRecord | null>;
  /** Adds a context revision if `baseContextRevisionId` is still the latest, else returns 'stale'. */
  addContext(input: {
    ownerId: string;
    sessionId: string;
    baseContextRevisionId: string;
    context: ContextInput;
    now: Date;
  }): Promise<ContextRevision | 'stale' | null>;
  getQuestionSet(
    ownerId: string,
    sessionId: string,
    questionSetId: string,
  ): Promise<QuestionSetRecord | null>;
  /** Stores a generated question set under the session's owner; null when the session is not theirs. */
  saveQuestionSet(
    ownerId: string,
    set: QuestionSetRecord,
    now: Date,
  ): Promise<QuestionSetRecord | null>;
  /** Records an answer revision and returns the new latest context, or 'stale'. */
  addAnswers(input: {
    ownerId: string;
    sessionId: string;
    baseContextRevisionId: string;
    questionSetId: string;
    answers: Answer[];
    /** Hash of the canonical answers; folded into the new revision's contextHash. */
    answersHash: string;
    now: Date;
  }): Promise<ContextRevision | 'stale' | null>;
  delete(ownerId: string, sessionId: string): Promise<boolean>;
}

export type Store = {
  jobs: JobStore;
  outbox: OutboxStore;
  execution: ExecutionStore;
  documents: DocumentStore;
  sessions: SessionStore;
};
