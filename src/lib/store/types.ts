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

/*
 * Persistence boundary of the API. Every read and write is scoped by `ownerId`: a record owned
 * by someone else is indistinguishable from a missing one, so ownership cannot be skipped by a
 * handler. The Supabase implementation (private llm schema, MDI-214) replaces the memory and
 * unconfigured stores without changing these interfaces.
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

export type AdmitJobInput = {
  ownerId: string;
  idempotencyKey: string;
  requestHash: string;
  request: CreateJobRequest;
  now: Date;
  deadlineAt: Date;
};

export interface JobStore {
  findByIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<JobRecord | null>;
  /**
   * Atomically creates the job (and, with MDI-214/215, its quota holds and outbox event).
   * Returns the existing job for a replay with the same hash and throws
   * IdempotencyConflictError for the same key with a different hash.
   */
  admit(input: AdmitJobInput): Promise<{ job: JobRecord; replayed: boolean }>;
  get(ownerId: string, jobId: string): Promise<JobRecord | null>;
  list(
    ownerId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ jobs: JobRecord[]; nextCursor: string | null }>;
  /** Moves a non-terminal job to cancelled; returns the job unchanged when already terminal. */
  cancel(ownerId: string, jobId: string, now: Date): Promise<JobRecord | null>;
  /** Requeues a failed job; eligibility is checked by the caller. */
  retry(ownerId: string, jobId: string, now: Date): Promise<JobRecord | null>;
  delete(ownerId: string, jobId: string): Promise<boolean>;
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

export interface AccountStore {
  /** False for deleted or revoked accounts, even while their tokens have not expired. */
  isActive(userId: string): Promise<boolean>;
}

export type Store = {
  accounts: AccountStore;
  jobs: JobStore;
  documents: DocumentStore;
  uploads: UploadGrants;
  sessions: SessionStore;
};
