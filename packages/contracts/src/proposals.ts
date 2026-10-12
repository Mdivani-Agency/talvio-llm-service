import { z } from 'zod';

import {
  careerDocumentSchema,
  educationEntrySchema,
  experienceEntrySchema,
  languageItemSchema,
  linkItemSchema,
  namedItemSchema,
  projectEntrySchema,
  recommendationEntrySchema,
} from './career';
import { contentDocSchema } from './content';
import { evidenceRefSchema } from './evidence';
import { LIMITS } from './limits';
import {
  duplicateIds,
  longTextSchema,
  sha256Schema,
  shortTextSchema,
  stableIdSchema,
  uuidSchema,
} from './primitives';
import { resumeTypeEnum, sourceRefSchema } from './source';

/*
 * Reviewable proposals (design §§5, 9, 12). The model proposes changed fields only; the service
 * restores everything else exactly. There is no free-form JSON Patch: every change names one
 * entity and one field from TARGETABLE_FIELDS, with the original value as a precondition.
 */

/**
 * Fields a proposal may change, per section. Contacts are never targeted: they are reattached
 * deterministically and excluded from composition. Dates, employers and titles are facts the
 * service does not rewrite.
 */
export const TARGETABLE_FIELDS = {
  person: ['role', 'tagline'],
  experience: ['description', 'achievements', 'responsibilities', 'keyContributions'],
  education: ['description'],
  projects: ['description'],
  recommendations: ['description'],
} as const;

export const targetSectionEnum = z.enum([
  'person',
  'experience',
  'education',
  'projects',
  'recommendations',
]);

/** Sections where a proposal may add a new entity (always with user confirmation). */
export const ADDABLE_SECTIONS = ['skills', 'tools', 'languages', 'links'] as const;
export const addableSectionEnum = z.enum(ADDABLE_SECTIONS);

export const fieldValueSchema = z.union([
  z.null(),
  longTextSchema,
  z.array(longTextSchema).max(LIMITS.bulletsPerEntry),
  contentDocSchema,
]);

export const changeTargetSchema = z
  .strictObject({
    section: targetSectionEnum,
    /** `null` for the person section, which has no entities. */
    entityId: stableIdSchema.nullable(),
    field: z.string().max(64),
  })
  .refine(
    (target) => (TARGETABLE_FIELDS[target.section] as readonly string[]).includes(target.field),
    { message: 'field is not targetable in this section', path: ['field'] },
  )
  .refine((target) => (target.section === 'person') === (target.entityId === null), {
    message: 'entityId is required except for the person section',
    path: ['entityId'],
  });

export const claimSchema = z.strictObject({
  id: stableIdSchema,
  /** The claim in plain words, e.g. "You led a team of 5". */
  text: z.string().max(500),
});

/**
 * `required` is true whenever deterministic rules cannot show the change keeps the source's
 * meaning. The user must confirm each listed claim before the change can be applied.
 */
export const confirmationSchema = z.strictObject({
  required: z.boolean(),
  claims: z.array(claimSchema).max(10),
});

const changeBase = {
  id: stableIdSchema,
  reason: z.string().max(500),
  factIds: z.array(stableIdSchema).max(20),
  evidence: z.array(evidenceRefSchema).max(20),
  confirmation: confirmationSchema,
};

/** Rewrites one field. `rewrite` keeps the facts; `factual_addition` adds a fact from answers. */
/** The value shape each targetable field holds. */
const FIELD_VALUE_SCHEMAS: Record<string, z.ZodType> = {
  role: shortTextSchema.nullable(),
  tagline: longTextSchema.nullable(),
  description: contentDocSchema.nullable(),
  achievements: z.array(longTextSchema).max(LIMITS.bulletsPerEntry),
  responsibilities: z.array(longTextSchema).max(LIMITS.bulletsPerEntry),
  keyContributions: z.array(longTextSchema).max(LIMITS.bulletsPerEntry),
};

export const fieldChangeSchema = z
  .strictObject({
    type: z.literal('field'),
    changeKind: z.enum(['rewrite', 'factual_addition']),
    target: changeTargetSchema,
    /** Precondition: apply fails if the target no longer holds this value. */
    originalValue: fieldValueSchema,
    proposedValue: fieldValueSchema,
    ...changeBase,
  })
  .superRefine((change, ctx) => {
    const schema = FIELD_VALUE_SCHEMAS[change.target.field];
    for (const key of ['originalValue', 'proposedValue'] as const) {
      if (schema && !schema.safeParse(change[key]).success) {
        ctx.addIssue({
          code: 'custom',
          message: 'value does not fit the target field',
          path: [key],
        });
      }
    }
  });

export const addedEntitySchema = z.discriminatedUnion('section', [
  z.strictObject({ section: z.literal('skills'), entity: namedItemSchema }),
  z.strictObject({ section: z.literal('tools'), entity: namedItemSchema }),
  z.strictObject({ section: z.literal('languages'), entity: languageItemSchema }),
  z.strictObject({ section: z.literal('links'), entity: linkItemSchema }),
]);

/** Adding an entity always needs the user's confirmation of at least one claim. */
export const entityAdditionSchema = z
  .strictObject({
    type: z.literal('add_entity'),
    changeKind: z.literal('factual_addition'),
    addition: addedEntitySchema,
    ...changeBase,
  })
  .refine((change) => change.confirmation.required && change.confirmation.claims.length > 0, {
    message: 'an entity addition must require confirmation of at least one claim',
    path: ['confirmation'],
  });

export const proposedChangeSchema = z.discriminatedUnion('type', [
  fieldChangeSchema,
  entityAdditionSchema,
]);

/** Any entity that can be dropped from a composed resume. */
export const omittedValueSchema = z.union([
  experienceEntrySchema,
  educationEntrySchema,
  projectEntrySchema,
  recommendationEntrySchema,
  namedItemSchema,
  linkItemSchema,
  languageItemSchema,
  fieldValueSchema,
]);

/**
 * Content the proposal leaves out. Every removed fact is listed; a rejected omission keeps the
 * original content.
 */
export const omissionSchema = z.strictObject({
  id: stableIdSchema,
  section: z.string().max(32),
  entityId: stableIdSchema.nullable(),
  field: z.string().max(64).nullable(),
  originalValue: omittedValueSchema,
  reason: z.string().max(500),
});

/*
 * Where an accepted proposal is saved. The web owns the write (design §12); workers never
 * write canonical data.
 * - `profile`: update the profile at `baseRevision`.
 * - `resume_draft`: update a mutable resume at `baseRevision`.
 * - `resume_draft_family`: the source is a generated (immutable) resume; save into its one
 *   open draft, creating it if needed. The generated resume itself is never modified.
 * - `new_resume`: create a new resume (JOB_SPECIFIC for tailoring). It is not part of the
 *   source's draft family: `source_resume_id` stays reserved for drafts of generated resumes,
 *   and the origin is recorded as provenance instead.
 */
export const applyTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('profile'),
    profileId: uuidSchema,
    baseRevision: z.string().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal('resume_draft'),
    resumeId: uuidSchema,
    baseRevision: z.string().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal('resume_draft_family'),
    generatedResumeId: uuidSchema,
  }),
  z.strictObject({
    kind: z.literal('new_resume'),
    resumeType: resumeTypeEnum,
    derivedFrom: sourceRefSchema,
  }),
]);

export const proposalSchema = z
  .strictObject({
    proposalId: uuidSchema,
    source: sourceRefSchema,
    /** Hash of the canonical source snapshot the proposal was made from. */
    sourceHash: sha256Schema,
    applyTarget: applyTargetSchema,
    changes: z.array(proposedChangeSchema).max(200),
    omissions: z.array(omissionSchema).max(200),
    /** Tailoring only: the complete composed document the changes produce. */
    document: careerDocumentSchema.nullable(),
    summary: z.string().max(2_000),
  })
  .refine(
    (proposal) =>
      duplicateIds([
        ...proposal.changes.map((change) => change.id),
        ...proposal.omissions.map((omission) => omission.id),
      ]).length === 0,
    { message: 'change and omission ids must be unique', path: ['changes'] },
  )
  .refine(
    (proposal) =>
      duplicateIds(
        proposal.changes.flatMap((change) => change.confirmation.claims.map((claim) => claim.id)),
      ).length === 0,
    { message: 'claim ids must be unique across the proposal', path: ['changes'] },
  );

export type FieldValue = z.infer<typeof fieldValueSchema>;
export type ChangeTarget = z.infer<typeof changeTargetSchema>;
export type ProposedChange = z.infer<typeof proposedChangeSchema>;
export type Omission = z.infer<typeof omissionSchema>;
export type ApplyTarget = z.infer<typeof applyTargetSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
