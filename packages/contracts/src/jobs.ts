import { z } from 'zod';

import { ApplyTargetError, applyTargetFor, type ProposalOperation } from './apply';
import { canonicalJson } from './canonical';

import { jobErrorSchema } from './errors';
import { warningSchema } from './evidence';
import {
  Operation,
  OPERATIONS,
  operationInputSchemas,
  operationResultSchemas,
  operationEnum,
} from './operations';
import {
  idempotencyKeySchema,
  isoDateTimeSchema,
  localeSchema,
  revisionSchema,
  sha256Schema,
  uuidSchema,
} from './primitives';
import type { ApplyTarget, Proposal } from './proposals';
import { schemaVersionSchema } from './version';

/*
 * One async job API for every operation (design §§4–6, 8).
 * POST /jobs → 202 JobAccepted; GET /jobs/{id} → Job. The `Idempotency-Key` header is required
 * and must equal `clientRequestId`: the same key with the same canonical body returns the
 * original job, the same key with a different body returns 409 idempotency_conflict.
 */

export const jobStatusEnum = z.enum([
  'queued',
  'running',
  'waiting_external',
  'retry_wait',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);
export type JobStatus = z.infer<typeof jobStatusEnum>;
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'expired',
];

/** Coarse progress shown to the user; no completion percentages. */
export const jobStageEnum = z.enum([
  'admission',
  'extraction',
  'ocr',
  'safeguard',
  'inference',
  'validation',
  'publishing',
  'done',
]);

const requestBase = {
  schemaVersion: schemaVersionSchema,
  clientRequestId: idempotencyKeySchema,
  locale: localeSchema,
};

const sessionBinding = {
  sessionId: uuidSchema,
  contextRevisionId: uuidSchema,
  /** Optional dependency on an earlier job in the same session; never proof of ownership. */
  parentJobId: uuidSchema.nullable(),
};

export const parseDocumentJobRequestSchema = z.strictObject({
  ...requestBase,
  operation: z.literal('parse_document'),
  input: operationInputSchemas.parse_document,
});

const sessionJobRequest = <O extends Exclude<Operation, 'parse_document'>>(operation: O) =>
  z.strictObject({
    ...requestBase,
    ...sessionBinding,
    operation: z.literal(operation),
    input: operationInputSchemas[operation],
  });

export const analyzeResumeJobRequestSchema = sessionJobRequest('analyze_resume');
export const generateQuestionsJobRequestSchema = sessionJobRequest('generate_questions');
export const improveProfileJobRequestSchema = sessionJobRequest('improve_profile');
export const improveResumeJobRequestSchema = sessionJobRequest('improve_resume');
export const tailorResumeJobRequestSchema = sessionJobRequest('tailor_resume');

export const createJobRequestSchema = z.discriminatedUnion('operation', [
  parseDocumentJobRequestSchema,
  analyzeResumeJobRequestSchema,
  generateQuestionsJobRequestSchema,
  improveProfileJobRequestSchema,
  improveResumeJobRequestSchema,
  tailorResumeJobRequestSchema,
]);
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;

export const jobAcceptedSchema = z.strictObject({
  jobId: uuidSchema,
  status: jobStatusEnum,
  statusUrl: z.string().regex(/^\/llm\/v1\/jobs\/[0-9a-f-]{36}$/),
  pollAfterMs: z.int().min(500).max(30_000),
  /** True when the Idempotency-Key matched an existing job. */
  replayed: z.boolean(),
});
export type JobAccepted = z.infer<typeof jobAcceptedSchema>;

export const resultVersionsSchema = z.strictObject({
  pipelineReleaseId: z.string().min(1).max(64),
  promptVersion: z.string().min(1).max(64),
  modelId: z.string().min(1).max(128),
});

type EnvelopeFields = {
  operation: Operation;
  contextRevisionId: string | null;
  contextHash: string | null;
  sourceRevision: string | null;
  result: { proposal?: Proposal };
};

/**
 * Session results must carry their context bindings (only parse_document has none), and a
 * proposal's apply target must be the one applyTargetFor allows for its operation and source.
 */
function checkEnvelope(envelope: EnvelopeFields, ctx: z.RefinementCtx) {
  if (envelope.operation !== 'parse_document') {
    for (const field of ['contextRevisionId', 'contextHash', 'sourceRevision'] as const) {
      if (envelope[field] === null) {
        ctx.addIssue({ code: 'custom', message: `${field} is required`, path: [field] });
      }
    }
  }
  const proposal = envelope.result.proposal;
  if (!proposal) {
    return;
  }
  // The publisher fills sourceRevision from the admitted context, never from model output;
  // a proposal for any other revision is not this job's.
  if (proposal.source.revision !== envelope.sourceRevision) {
    ctx.addIssue({
      code: 'custom',
      message: 'proposal source does not match the admitted context',
      path: ['result', 'proposal', 'source'],
    });
  }
  let expected: ApplyTarget | null = null;
  try {
    expected = applyTargetFor(envelope.operation as ProposalOperation, proposal.source);
  } catch (error) {
    if (!(error instanceof ApplyTargetError)) {
      throw error;
    }
  }
  if (!expected || canonicalJson(expected) !== canonicalJson(proposal.applyTarget)) {
    ctx.addIssue({
      code: 'custom',
      message: 'applyTarget is not allowed for this operation and source',
      path: ['result', 'proposal', 'applyTarget'],
    });
  }
}

/** Every published result carries its bindings, so stale results are detectable. */
const resultEnvelope = <O extends Operation>(operation: O) =>
  z
    .strictObject({
      jobId: uuidSchema,
      schemaVersion: schemaVersionSchema,
      operation: z.literal(operation),
      inputHash: sha256Schema,
      contextRevisionId: uuidSchema.nullable(),
      contextHash: sha256Schema.nullable(),
      sourceRevision: revisionSchema.nullable(),
      versions: resultVersionsSchema,
      /** `partial` results must be acknowledged before use; they never look complete. */
      resultKind: z.enum(['complete', 'partial']),
      warnings: z.array(warningSchema).max(100),
      result: operationResultSchemas[operation],
    })
    .superRefine((envelope, ctx) => checkEnvelope(envelope as unknown as EnvelopeFields, ctx));

export const resultEnvelopeSchemas = Object.fromEntries(
  OPERATIONS.map((operation) => [operation, resultEnvelope(operation)]),
) as { [O in Operation]: ReturnType<typeof resultEnvelope<O>> };

export type ResultEnvelope<O extends Operation> = z.infer<(typeof resultEnvelopeSchemas)[O]>;

type JobStateFields = {
  jobId: string;
  status: JobStatus;
  result: { jobId: string } | null;
  error: unknown;
};

/** A result exactly when succeeded; an error whenever failed or expired. */
function checkJobState(job: JobStateFields, ctx: z.RefinementCtx) {
  if (job.result && job.result.jobId !== job.jobId) {
    ctx.addIssue({
      code: 'custom',
      message: 'result belongs to another job',
      path: ['result', 'jobId'],
    });
  }
  if ((job.status === 'succeeded') !== (job.result !== null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'result is present exactly when the job succeeded',
      path: ['result'],
    });
  }
  if ((job.status === 'failed' || job.status === 'expired') && job.error === null) {
    ctx.addIssue({
      code: 'custom',
      message: 'failed and expired jobs carry an error',
      path: ['error'],
    });
  }
  if (job.status === 'succeeded' && job.error !== null) {
    ctx.addIssue({ code: 'custom', message: 'a succeeded job has no error', path: ['error'] });
  }
}

const jobState = <O extends Operation, R extends z.ZodType>(operation: O, resultSchema: R) =>
  z
    .strictObject({
      jobId: uuidSchema,
      operation: z.literal(operation),
      status: jobStatusEnum,
      stage: jobStageEnum,
      sessionId: uuidSchema.nullable(),
      contextRevisionId: uuidSchema.nullable(),
      parentJobId: uuidSchema.nullable(),
      createdAt: isoDateTimeSchema,
      updatedAt: isoDateTimeSchema,
      /** Admission time plus LIMITS.jobDeadlineMs; retries never extend it. */
      deadlineAt: isoDateTimeSchema,
      /** Suggested delay before the next poll; null once terminal. */
      pollAfterMs: z.int().min(500).max(30_000).nullable(),
      result: resultSchema.nullable(),
      error: jobErrorSchema.nullable(),
    })
    .superRefine((job, ctx) => checkJobState(job as unknown as JobStateFields, ctx));

export const jobSchema = z.discriminatedUnion('operation', [
  jobState('parse_document', resultEnvelopeSchemas.parse_document),
  jobState('analyze_resume', resultEnvelopeSchemas.analyze_resume),
  jobState('generate_questions', resultEnvelopeSchemas.generate_questions),
  jobState('improve_profile', resultEnvelopeSchemas.improve_profile),
  jobState('improve_resume', resultEnvelopeSchemas.improve_resume),
  jobState('tailor_resume', resultEnvelopeSchemas.tailor_resume),
]);
export type Job = z.infer<typeof jobSchema>;

export const jobListSchema = z.strictObject({
  jobs: z.array(jobSchema).max(50),
  nextCursor: z.string().max(256).nullable(),
});

export const jobOperationSchema = operationEnum;
