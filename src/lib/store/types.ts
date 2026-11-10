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
  admit(input: AdmitJobInput): Promise<{ job: JobRecord; replayed: boolean }>;
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

export type OutboxEvent = {
  eventId: string;
  type: 'job.admitted' | 'job.retried';
  ownerId: string;
  jobId: string;
  operation: Operation;
  createdAt: Date;
};

/** Events written with the job in one transaction; the dispatcher (MDI-215) hands them to the work queues. */
export interface OutboxStore {
  pending(limit: number): Promise<OutboxEvent[]>;
  markDispatched(event: OutboxEvent, now: Date): Promise<void>;
}

export type DocumentRecord = {
  documentId: string;
  ownerId: string;
  status: DocumentStatus;
  contentType: CreateDocumentRequest['contentType'];
  sizeBytes: number;
  sha256: string;
  pageCount: number | null;
  ocrPages: number[];
  createdAt: Date;
  expiresAt: Date;
};

export type UploadGrant = {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
};

export interface DocumentStore {
  create(ownerId: string, request: CreateDocumentRequest, now: Date): Promise<DocumentRecord>;
  get(ownerId: string, documentId: string): Promise<DocumentRecord | null>;
  /** awaiting_upload → validating; other states are returned unchanged. */
  complete(ownerId: string, documentId: string, now: Date): Promise<DocumentRecord | null>;
  delete(ownerId: string, documentId: string): Promise<boolean>;
}

/** Short-lived private upload grants (S3 presign with MDI-213/216). */
export interface UploadGrants {
  create(document: DocumentRecord, now: Date): Promise<UploadGrant>;
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
  documents: DocumentStore;
  uploads: UploadGrants;
  sessions: SessionStore;
};
