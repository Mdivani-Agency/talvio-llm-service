import { z } from 'zod';

import { careerDocumentSchema, careerSectionEnum } from './career';
import { evidenceRefSchema, factSchema } from './evidence';
import { requirementCoverageSchema, requirementSchema } from './job-description';
import { LIMITS } from './limits';
import { shortTextSchema, stableIdSchema, uuidSchema } from './primitives';
import { proposalSchema, targetSectionEnum } from './proposals';
import { questionSetSchema } from './questions';

/*
 * Operation inputs and typed results (design §5). Session-bound operations read their source,
 * job description and answers from the session's context revision, so their `input` holds only
 * operation options. parse_document is the one operation that takes content directly.
 */

export const OPERATIONS = [
  'parse_document',
  'analyze_resume',
  'generate_questions',
  'improve_profile',
  'improve_resume',
  'tailor_resume',
] as const;
export const operationEnum = z.enum(OPERATIONS);
export type Operation = z.infer<typeof operationEnum>;

/** Operations that run against a session context revision. */
export const SESSION_OPERATIONS = [
  'analyze_resume',
  'generate_questions',
  'improve_profile',
  'improve_resume',
  'tailor_resume',
] as const satisfies readonly Operation[];

// parse_document

/** Page-aware diagnostics from browser extraction (pdfjs-dist). */
export const extractionManifestSchema = z.strictObject({
  extractor: z.enum(['pdfjs-dist']),
  extractorVersion: z.string().max(32),
  pageCount: z.int().min(1).max(LIMITS.pdfPages),
  pages: z
    .array(
      z.strictObject({
        page: z.int().min(1),
        /** Half-open range of this page in the submitted text. */
        start: z.int().min(0),
        end: z.int().min(0),
        coverage: z.enum(['text', 'empty', 'uncertain']),
      }),
    )
    .max(LIMITS.pdfPages),
});

export const parseDocumentInputSchema = z.discriminatedUnion('kind', [
  /** Pasted text, or text the browser extracted from a PDF (then with a manifest). */
  z.strictObject({
    kind: z.literal('text'),
    text: z.string().trim().min(1).max(LIMITS.sourceTextChars),
    extraction: extractionManifestSchema.nullable(),
  }),
  /** An uploaded document that reached `ready` (see documents.ts). */
  z.strictObject({
    kind: z.literal('document'),
    documentId: uuidSchema,
  }),
]);

export const uncertaintySchema = z.strictObject({
  id: stableIdSchema,
  section: careerSectionEnum,
  entityId: stableIdSchema.nullable(),
  field: z.string().max(64).nullable(),
  reason: z.enum(['ambiguous', 'conflicting', 'unreadable', 'incomplete', 'unknown_date']),
  message: z.string().max(500),
  evidence: z.array(evidenceRefSchema).max(10),
});

export const parseDocumentResultSchema = z.strictObject({
  /** Partial career data staged for review; ids are `parsed:<section>:<n>`. */
  career: careerDocumentSchema,
  facts: z.array(factSchema).max(1_000),
  uncertainties: z.array(uncertaintySchema).max(200),
  extraction: z.strictObject({
    method: z.enum(['plain_text', 'client_pdf_text', 'server_pdf_text', 'pdf_ocr', 'docx']),
    ocrPages: z.int().min(0).max(LIMITS.ocrPages),
    /** False when any page or region could not be read; the result is then `partial`. */
    complete: z.boolean(),
    pagesNeedingReview: z.array(z.int().min(1)).max(LIMITS.pdfPages),
  }),
});

// analyze_resume

export const analyzeResumeInputSchema = z.strictObject({
  /** Sections to analyze; empty means all. */
  sections: z.array(careerSectionEnum).max(11),
});

export const findingSchema = z.strictObject({
  id: stableIdSchema,
  severity: z.enum(['high', 'medium', 'low']),
  category: z.enum([
    'missing_information',
    'weak_evidence',
    'clarity',
    'impact',
    'consistency',
    'job_match',
  ]),
  section: careerSectionEnum.nullable(),
  entityId: stableIdSchema.nullable(),
  message: z.string().max(500),
  evidence: z.array(evidenceRefSchema).max(10),
});

export const analyzeResumeResultSchema = z.strictObject({
  findings: z.array(findingSchema).max(50),
  /** Empty without a job description. */
  requirements: z.array(requirementSchema).max(50),
  coverage: z.array(requirementCoverageSchema).max(50),
  /** Finding ids in priority order. */
  priorities: z.array(stableIdSchema).max(50),
});

// generate_questions

export const generateQuestionsInputSchema = z.strictObject({
  /** A compatible analyze_resume job to build on, if any. */
  analysisJobId: uuidSchema.nullable(),
  round: z.int().min(1).max(LIMITS.questionRoundsPerSession),
  maxQuestions: z.int().min(0).max(LIMITS.questionsPerSet),
});

/** Zero questions is a valid result: the source already answers everything relevant. */
export const generateQuestionsResultSchema = questionSetSchema;

// improve_profile / improve_resume

export const improveInputSchema = z.strictObject({
  /** Sections the user asked to improve; empty means every targetable section. */
  sections: z.array(targetSectionEnum).max(5),
  /** Optional target role used for emphasis only, never as a source of facts. */
  targetRole: shortTextSchema.nullable(),
});

export const improveResultSchema = z.strictObject({
  proposal: proposalSchema,
});

// tailor_resume

export const tailorResumeInputSchema = z.strictObject({
  /** Name for the new JOB_SPECIFIC resume. */
  resumeName: shortTextSchema.min(1),
});

export const tailorResumeResultSchema = z
  .strictObject({
    /** `proposal.document` holds the composed resume; `applyTarget` is always a new resume. */
    proposal: proposalSchema,
    requirements: z.array(requirementSchema).max(50),
    coverage: z.array(requirementCoverageSchema).max(50),
    /** Requirements the candidate's evidence does not support; never invented. */
    unsupportedRequirementIds: z.array(stableIdSchema).max(50),
  })
  .refine((result) => result.proposal.document !== null, {
    message: 'a tailoring proposal carries the composed document',
    path: ['proposal', 'document'],
  });

export const operationInputSchemas = {
  parse_document: parseDocumentInputSchema,
  analyze_resume: analyzeResumeInputSchema,
  generate_questions: generateQuestionsInputSchema,
  improve_profile: improveInputSchema,
  improve_resume: improveInputSchema,
  tailor_resume: tailorResumeInputSchema,
} as const;

export const operationResultSchemas = {
  parse_document: parseDocumentResultSchema,
  analyze_resume: analyzeResumeResultSchema,
  generate_questions: generateQuestionsResultSchema,
  improve_profile: improveResultSchema,
  improve_resume: improveResultSchema,
  tailor_resume: tailorResumeResultSchema,
} as const;

export type OperationInput<O extends Operation> = z.infer<(typeof operationInputSchemas)[O]>;
export type OperationResult<O extends Operation> = z.infer<(typeof operationResultSchemas)[O]>;
export type ParseDocumentInput = OperationInput<'parse_document'>;
export type ParseDocumentResult = OperationResult<'parse_document'>;
