import { z } from 'zod';

import { evidenceRefSchema } from './evidence';
import { LIMITS } from './limits';
import { shortTextSchema, stableIdSchema } from './primitives';

/**
 * A pasted job description. `url` is a label only: the service never fetches it.
 * JD requirements live in their own namespace and never count as evidence for a candidate fact.
 */
export const jobDescriptionSchema = z.strictObject({
  text: z.string().trim().min(1).max(LIMITS.jobDescriptionChars),
  title: shortTextSchema.nullable(),
  company: shortTextSchema.nullable(),
  url: z
    .url({ protocol: /^https?$/ })
    .max(2_048)
    .nullable(),
});

export const requirementKindEnum = z.enum(['required', 'preferred']);

export const requirementSchema = z.strictObject({
  id: stableIdSchema,
  text: z.string().max(500),
  kind: requirementKindEnum,
  /** The span of the job description the requirement was taken from. */
  evidence: z.array(evidenceRefSchema).min(1).max(5),
});

export const coverageStatusEnum = z.enum(['supported', 'partial', 'missing']);

/** How well the candidate's own evidence covers one requirement. */
export const requirementCoverageSchema = z.strictObject({
  requirementId: stableIdSchema,
  status: coverageStatusEnum,
  /** Candidate-side evidence only: a job description span never supports a requirement. */
  evidence: z
    .array(evidenceRefSchema)
    .max(10)
    .refine((refs) => refs.every((ref) => ref.sourceKind !== 'job_description'), {
      message: 'coverage evidence must come from the candidate, not the job description',
    }),
  note: z.string().max(500).nullable(),
});

export type JobDescription = z.infer<typeof jobDescriptionSchema>;
export type Requirement = z.infer<typeof requirementSchema>;
export type RequirementCoverage = z.infer<typeof requirementCoverageSchema>;
