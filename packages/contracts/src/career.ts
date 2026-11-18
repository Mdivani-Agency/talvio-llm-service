import { z } from 'zod';

import { contentDocSchema } from './content';
import { LIMITS } from './limits';
import {
  duplicateIds,
  longTextSchema,
  partialDateSchema,
  shortTextSchema,
  stableIdSchema,
} from './primitives';

/*
 * Career data as the LLM service sees it. This is a contract type, not a database row or web
 * form type (MDI-194 owns those). The web maps its profile and resume models to a
 * CareerDocument when it creates a session context and maps accepted proposals back.
 *
 * Every entity carries a stable `id`, so proposals target entities by identity, never by
 * position. Unknown values are `null`; the service never fills them with guesses.
 */

// Enum values mirror talvio-web-app lib/schema/enums.ts and the database enums.
export const seniorityEnum = z.enum(['entry', 'mid', 'senior']);
export const employmentTypeEnum = z.enum([
  'full-time',
  'part-time',
  'contract',
  'self-employed',
  'volunteer',
  'internship',
  'apprenticeship',
  'seasonal',
]);
export const locationTypeEnum = z.enum(['remote', 'hybrid', 'office']);
export const languageProficiencyEnum = z.enum(['beginner', 'intermediate', 'fluent', 'native']);
export const degreeTypeEnum = z.enum([
  'Associate Degree',
  "Bachelor's Degree",
  "Master's Degree",
  'Doctorate Degree',
  'Professional Degree',
  'Certificate',
  'Diploma',
  'High School Diploma',
  'Trade School Certificate',
  'MBA',
  'MFA',
  'MEd',
  'MSW',
  'PhD',
  'JD',
  'MD',
  'EDD',
]);

const bulletsSchema = z.array(longTextSchema).max(LIMITS.bulletsPerEntry);

export const personSchema = z.strictObject({
  firstName: shortTextSchema.nullable(),
  lastName: shortTextSchema.nullable(),
  role: shortTextSchema.nullable(),
  tagline: longTextSchema.nullable(),
  seniority: seniorityEnum.nullable(),
});

export const contactsSchema = z.strictObject({
  email: shortTextSchema.nullable(),
  phone: shortTextSchema.nullable(),
  url: shortTextSchema.nullable(),
});

export const locationSchema = z.strictObject({
  city: shortTextSchema.nullable(),
  country: shortTextSchema.nullable(),
});

/**
 * Dates keep their known precision. `current` is `true` only when the source says so;
 * a missing end date leaves it `null`, never `true`.
 */
const periodShape = {
  startDate: partialDateSchema.nullable(),
  endDate: partialDateSchema.nullable(),
  current: z.boolean().nullable(),
};

export const experienceEntrySchema = z.strictObject({
  id: stableIdSchema,
  company: shortTextSchema.nullable(),
  jobTitle: shortTextSchema.nullable(),
  employmentType: employmentTypeEnum.nullable(),
  locationType: locationTypeEnum.nullable(),
  ...periodShape,
  description: contentDocSchema.nullable(),
  achievements: bulletsSchema,
  responsibilities: bulletsSchema,
  keyContributions: bulletsSchema,
});

export const educationEntrySchema = z.strictObject({
  id: stableIdSchema,
  name: shortTextSchema.nullable(),
  degreeType: degreeTypeEnum.nullable(),
  ...periodShape,
  description: contentDocSchema.nullable(),
});

export const projectEntrySchema = z.strictObject({
  id: stableIdSchema,
  name: shortTextSchema.nullable(),
  url: shortTextSchema.nullable(),
  description: contentDocSchema.nullable(),
});

export const recommendationEntrySchema = z.strictObject({
  id: stableIdSchema,
  name: shortTextSchema.nullable(),
  url: shortTextSchema.nullable(),
  description: contentDocSchema.nullable(),
});

export const namedItemSchema = z.strictObject({
  id: stableIdSchema,
  name: shortTextSchema,
});

export const linkItemSchema = z.strictObject({
  id: stableIdSchema,
  type: shortTextSchema.nullable(),
  value: shortTextSchema,
});

export const languageItemSchema = z.strictObject({
  id: stableIdSchema,
  language: shortTextSchema,
  proficiency: languageProficiencyEnum.nullable(),
});

const section = <T extends z.ZodType>(entry: T) => z.array(entry).max(LIMITS.entriesPerSection);

const ENTITY_SECTIONS = [
  'experience',
  'education',
  'projects',
  'recommendations',
  'skills',
  'tools',
  'links',
  'languages',
] as const;

/** Entity ids are unique across the whole document, so a change target is never ambiguous. */
export const careerDocumentSchema = z
  .strictObject({
    person: personSchema,
    contacts: contactsSchema,
    location: locationSchema,
    experience: section(experienceEntrySchema),
    education: section(educationEntrySchema),
    projects: section(projectEntrySchema),
    recommendations: section(recommendationEntrySchema),
    skills: section(namedItemSchema),
    tools: section(namedItemSchema),
    links: section(linkItemSchema),
    languages: section(languageItemSchema),
  })
  .superRefine((document, ctx) => {
    const ids = ENTITY_SECTIONS.flatMap((name) =>
      document[name].map((entity: { id: string }) => entity.id),
    );
    for (const id of duplicateIds(ids)) {
      ctx.addIssue({ code: 'custom', message: `duplicate entity id ${id}`, path: ['experience'] });
    }
  });

export const CAREER_SECTIONS = [
  'person',
  'contacts',
  'location',
  'experience',
  'education',
  'projects',
  'recommendations',
  'skills',
  'tools',
  'links',
  'languages',
] as const;
export const careerSectionEnum = z.enum(CAREER_SECTIONS);

export type CareerDocument = z.infer<typeof careerDocumentSchema>;
export type CareerSection = z.infer<typeof careerSectionEnum>;
export type ExperienceEntry = z.infer<typeof experienceEntrySchema>;
export type EducationEntry = z.infer<typeof educationEntrySchema>;
