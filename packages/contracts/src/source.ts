import { z } from 'zod';

import { careerDocumentSchema } from './career';
import { revisionSchema, uuidSchema } from './primitives';

/*
 * Where a career document came from. The service never writes canonical profiles or resumes;
 * it uses the source reference to bind results to an immutable revision and to tell the web
 * which apply path an accepted proposal takes (see apply.ts).
 */

export const resumeTypeEnum = z.enum(['general', 'job_specific']);

/**
 * `generated` resumes have a stored PDF and are immutable (MDI-174). Edits go through their
 * one open draft (`sourceResumeId` points at the generated parent), never to the generated row.
 */
export const resumeStateEnum = z.enum(['draft', 'generated']);

export const profileSourceSchema = z.strictObject({
  kind: z.literal('profile'),
  id: uuidSchema,
  revision: revisionSchema,
});

export const resumeSourceSchema = z.strictObject({
  kind: z.literal('resume'),
  id: uuidSchema,
  revision: revisionSchema,
  resumeType: resumeTypeEnum,
  state: resumeStateEnum,
  /** For a draft of a generated resume: the generated parent. */
  sourceResumeId: uuidSchema.nullable(),
});

export const sourceRefSchema = z.discriminatedUnion('kind', [
  profileSourceSchema,
  resumeSourceSchema,
]);

/** An immutable copy of a profile or resume submitted for one session context. */
export const sourceSnapshotSchema = z.strictObject({
  source: sourceRefSchema,
  document: careerDocumentSchema,
});

export type ResumeType = z.infer<typeof resumeTypeEnum>;
export type ResumeState = z.infer<typeof resumeStateEnum>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
