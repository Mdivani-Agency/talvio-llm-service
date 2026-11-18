import { z } from 'zod';

import { jobDescriptionSchema } from './job-description';
import { LIMITS } from './limits';
import { idempotencyKeySchema, isoDateTimeSchema, sha256Schema, uuidSchema } from './primitives';
import { answerSchema } from './questions';
import { sourceSnapshotSchema } from './source';
import { schemaVersionSchema } from './version';

/*
 * Sessions bind one AI journey (improve or tailor) to the user and to immutable context
 * revisions (design §§5, 12). Changing the source, the job description or any answer creates a
 * new context revision; results made for an older revision become stale.
 */

export const createSessionRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  /** Retrying with the same key returns the same session. */
  clientRequestId: idempotencyKeySchema,
  purpose: z.enum(['improve', 'tailor']),
  source: sourceSnapshotSchema,
  jobDescription: jobDescriptionSchema.nullable(),
});

export const createContextRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  /** The revision this one replaces; 409 stale_context if it is not the latest. */
  baseContextRevisionId: uuidSchema,
  source: sourceSnapshotSchema,
  jobDescription: jobDescriptionSchema.nullable(),
});

export const submitAnswersRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  baseContextRevisionId: uuidSchema,
  questionSetId: uuidSchema,
  /** Only ids issued in the question set are accepted. */
  answers: z.array(answerSchema).min(1).max(LIMITS.questionsPerSet),
});

export const contextRevisionSchema = z.strictObject({
  contextRevisionId: uuidSchema,
  sessionId: uuidSchema,
  /** Server-computed hash over source, job description, answers and options. */
  contextHash: sha256Schema,
  sourceHash: sha256Schema,
  jobDescriptionHash: sha256Schema.nullable(),
  answerRevisionId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

export const sessionSchema = z.strictObject({
  sessionId: uuidSchema,
  purpose: z.enum(['improve', 'tailor']),
  status: z.enum(['open', 'closed', 'expired', 'deleted']),
  latestContext: contextRevisionSchema,
  questionRoundsUsed: z.int().min(0).max(LIMITS.questionRoundsPerSession),
  questionsIssued: z.int().min(0).max(LIMITS.questionsPerSession),
  createdAt: isoDateTimeSchema,
  /** Sessions close at most seven days after creation, or earlier with their evidence. */
  expiresAt: isoDateTimeSchema,
});

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type ContextRevision = z.infer<typeof contextRevisionSchema>;
export type Session = z.infer<typeof sessionSchema>;
