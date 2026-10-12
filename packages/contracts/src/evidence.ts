import { z } from 'zod';

import { careerSectionEnum } from './career';
import {
  partialDateSchema,
  sha256Schema,
  shortTextSchema,
  stableIdSchema,
  uuidSchema,
} from './primitives';

/*
 * Evidence ties every fact, finding and proposed change to the source text that supports it
 * (design §5). A real citation is not proof of semantic support; validators and the user's
 * explicit confirmation decide that.
 */

export const evidenceSourceKindEnum = z.enum([
  'document',
  'profile',
  'resume',
  'answer',
  'job_description',
]);

const offsetSchema = z.int().min(0);

export const evidenceRefSchema = z
  .strictObject({
    sourceKind: evidenceSourceKindEnum,
    /** Hash of the immutable source revision the offsets refer to. */
    sourceHash: sha256Schema,
    /** Entity and field inside a profile/resume source. */
    entityId: stableIdSchema.nullable(),
    field: shortTextSchema.nullable(),
    /** 1-based page and block inside an uploaded document. */
    page: z.int().min(1).nullable(),
    block: z.int().min(0).nullable(),
    /** Half-open character range in the normalized text. */
    start: offsetSchema,
    end: offsetSchema,
    /** Matching range in the original text, when normalization moved it. */
    originalStart: offsetSchema.nullable(),
    originalEnd: offsetSchema.nullable(),
    /** The supporting span itself, bounded for review display. */
    excerpt: z.string().max(500),
    /** True for text extracted in the browser: the server did not inspect the original file. */
    clientSupplied: z.boolean(),
    /** For `answer` evidence: the question and answer revision. */
    questionId: stableIdSchema.nullable(),
    answerRevisionId: uuidSchema.nullable(),
  })
  .refine((ref) => ref.end >= ref.start, { message: 'end must not precede start', path: ['end'] })
  .refine((ref) => ref.sourceKind !== 'answer' || (ref.questionId && ref.answerRevisionId), {
    message: 'answer evidence needs questionId and answerRevisionId',
    path: ['questionId'],
  });

/** Status of a fact in the ledger. A source assertion is not verified employment history. */
export const factStatusEnum = z.enum(['supported', 'uncertain', 'conflicting', 'user_confirmed']);

export const factPredicateEnum = z.enum([
  'employer',
  'job_title',
  'start_date',
  'end_date',
  'current_role',
  'employment_type',
  'location',
  'degree',
  'institution',
  'skill',
  'tool',
  'language',
  'certification',
  'responsibility',
  'achievement',
  'metric',
  'project',
  'other',
]);

export const datePrecisionEnum = z.enum(['year', 'month', 'day']);

export const factSchema = z.strictObject({
  id: stableIdSchema,
  /** The entity the fact describes, e.g. an experience entry. */
  subjectEntityId: stableIdSchema.nullable(),
  section: careerSectionEnum.nullable(),
  predicate: factPredicateEnum,
  value: z.string().max(1_000),
  /** Quantity and unit for metrics ("40", "%"). */
  quantity: z.string().max(64).nullable(),
  unit: z.string().max(32).nullable(),
  qualifiers: z.array(z.string().max(200)).max(10),
  /** "did not manage", "assisted with" and similar must keep their polarity. */
  negated: z.boolean(),
  date: partialDateSchema.nullable(),
  datePrecision: datePrecisionEnum.nullable(),
  status: factStatusEnum,
  evidence: z.array(evidenceRefSchema).max(20),
});

export const warningSchema = z.strictObject({
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(64),
  message: z.string().max(500),
  entityId: stableIdSchema.nullable(),
  page: z.int().min(1).nullable(),
});

export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type Fact = z.infer<typeof factSchema>;
export type Warning = z.infer<typeof warningSchema>;
