import { z } from 'zod';

import { CareerDocument, careerDocumentSchema } from './career';
import { ContentDoc } from './content';
import type { Operation } from './operations';

/*
 * The current web AI routes (talvio-web-app, development @ 6ced44c) and what replaces them.
 * The schemas below describe what those routes exchange today so fixtures can pin the current
 * flow; they are migration aids only and are never accepted by the service.
 */

export type LegacyRoute = {
  route: string;
  request: string;
  response: string;
  callers: string[];
  replacement: Operation[];
  notes: string;
};

export const LEGACY_ROUTES: readonly LegacyRoute[] = [
  {
    route: 'POST /api/resume/parse',
    request: '{ resume: string } (pasted text or pdfjs text)',
    response: 'JSON string of ParsedAccount, encoded twice (a JSON string inside JSON)',
    callers: ['hooks/use-resume-parser.ts (onboarding import, app/resume/views/import-page.tsx)'],
    replacement: ['parse_document'],
    notes:
      'Input becomes { kind: "text", text, extraction } or an uploaded document. The result is a typed object with evidence, uncertainties and coverage; it is never double-encoded.',
  },
  {
    route: 'POST /api/resume/qa',
    request: '{ resume: string } (JSON.stringify of documentToAiPayload(resume))',
    response: '{ questions: [{ question, example }] } with ids assigned on the client by position',
    callers: ['app/resume/hooks/use-ai-improve.ts (fetchQuestions)'],
    replacement: ['generate_questions'],
    notes:
      'The source moves into a session context (POST /sessions). Question ids, topic keys and reasons are issued by the server; answers are keyed by id (POST /sessions/{id}/answers).',
  },
  {
    route: 'POST /api/resume/account',
    request: '{ account: string, questions: string[], answers: string[] } paired by position',
    response: '{ account: ParsedAccount } (a whole regenerated account)',
    callers: ['app/resume/hooks/use-ai-improve.ts (fetchAccountProposal)'],
    replacement: ['improve_resume', 'improve_profile'],
    notes:
      'Returns field-level changes with preconditions and evidence instead of a whole account, so applyAiProposal no longer has to match entries by position.',
  },
  {
    route: 'POST /api/resume/complete',
    request: '{ resume: string, questions: string[], answers: string[] }',
    response: 'Text extracted from a ```json fence',
    callers: [],
    replacement: [],
    notes:
      'No UI caller remains (llm.client updateResume is unused); only e2e access/cap specs call it. Retire it without a replacement; job-specific drafting is tailor_resume.',
  },
];

// Current payload shapes (lib/schema/account.schema.ts, lib/schema/parsed.schema.ts).

const optionalString = z.string().nullish();
const optionalStrings = z.array(z.string()).nullish();

const legacyEntryBase = {
  id: optionalString,
  startDate: optionalString,
  endDate: optionalString,
  additionalDetails: optionalString,
};

/** documentToAiPayload output: the account-shaped JSON /qa and /account receive. */
export const legacyAccountSchema = z.object({
  profile: z
    .object({
      firstName: optionalString,
      lastName: optionalString,
      role: optionalString,
      email: optionalString,
      tagline: optionalString,
      phone: optionalString,
      website: optionalString,
      city: optionalString,
      country: optionalString,
      seniority: optionalString,
    })
    .nullish(),
  experience: z
    .array(
      z.object({
        ...legacyEntryBase,
        company: optionalString,
        jobTitle: optionalString,
        employmentType: optionalString,
        locationType: optionalString,
        /** boolean in the account form, an ISO date string in parse output. */
        isPresent: z.union([z.boolean(), z.string()]).nullish(),
        achievements: optionalStrings,
        responsibilities: optionalStrings,
        keyContributions: optionalStrings,
      }),
    )
    .nullish(),
  education: z
    .array(
      z.object({
        ...legacyEntryBase,
        name: optionalString,
        degreeType: optionalString,
        isPresent: z.union([z.boolean(), z.string()]).nullish(),
      }),
    )
    .nullish(),
  projects: z
    .array(
      z.object({
        id: optionalString,
        name: optionalString,
        url: optionalString,
        additionalDetails: optionalString,
      }),
    )
    .nullish(),
  recommendations: z
    .array(
      z.object({
        id: optionalString,
        name: optionalString,
        url: optionalString,
        additionalDetails: optionalString,
      }),
    )
    .nullish(),
  skills: z.array(z.object({ id: optionalString, name: optionalString })).nullish(),
  tools: z.array(z.object({ id: optionalString, name: optionalString })).nullish(),
  links: z
    .array(z.object({ id: optionalString, type: optionalString, value: optionalString }))
    .nullish(),
  languages: z
    .array(z.object({ id: optionalString, language: optionalString, proficiency: optionalString }))
    .nullish(),
});
export type LegacyAccount = z.infer<typeof legacyAccountSchema>;

/** Today's /qa response. */
export const legacyQuestionsResponseSchema = z.object({
  questions: z.array(z.object({ question: z.string(), example: z.string().nullable() })),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const text = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** ISO datetime to a day-precision partial date; anything unparseable becomes null. */
function partialDate(value: string | null | undefined): string | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/**
 * `isPresent` is only trusted as a boolean. Parse output sets it to a date whenever the end date
 * is missing, which is a guess, so a string never makes the role current.
 */
function current(
  isPresent: boolean | string | null | undefined,
  endDate: string | null,
): boolean | null {
  if (typeof isPresent === 'boolean') {
    return isPresent;
  }
  return endDate ? false : null;
}

function paragraphs(value: string | null | undefined): ContentDoc | null {
  const lines = (value ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return null;
  }
  return {
    type: 'doc',
    blocks: lines.map((line) => ({ type: 'paragraph', content: [{ text: line }] })),
  };
}

const bullets = (values: string[] | null | undefined) =>
  (values ?? []).map((value) => value.trim()).filter(Boolean);

function oneOf<T extends string>(
  allowed: readonly T[],
  value: string | null | undefined,
): T | null {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Converts today's account-shaped payload into a CareerDocument. Persisted UUIDs are kept;
 * other entries get `legacy:<section>:<n>` ids. Empty names are dropped from list sections.
 * Used by fixtures and contract tests to show the current flow fits the contract.
 */
export function legacyAccountToCareer(account: LegacyAccount): CareerDocument {
  const id = (section: string, index: number, value: string | null | undefined) =>
    value && UUID_RE.test(value) ? value.toLowerCase() : `legacy:${section}:${index}`;
  const profile = account.profile ?? {};
  const shape = careerDocumentSchema.shape;

  const document: CareerDocument = {
    person: {
      firstName: text(profile.firstName),
      lastName: text(profile.lastName),
      role: text(profile.role),
      tagline: text(profile.tagline),
      seniority: oneOf(shape.person.shape.seniority.unwrap().options, profile.seniority),
    },
    contacts: {
      email: text(profile.email),
      phone: text(profile.phone),
      url: text(profile.website),
    },
    location: { city: text(profile.city), country: text(profile.country) },
    experience: (account.experience ?? []).map((entry, index) => {
      const endDate = partialDate(entry.endDate);
      return {
        id: id('experience', index, entry.id),
        company: text(entry.company),
        jobTitle: text(entry.jobTitle),
        employmentType: oneOf(
          shape.experience.element.shape.employmentType.unwrap().options,
          entry.employmentType,
        ),
        locationType: oneOf(
          shape.experience.element.shape.locationType.unwrap().options,
          entry.locationType,
        ),
        startDate: partialDate(entry.startDate),
        endDate,
        current: current(entry.isPresent, endDate),
        description: paragraphs(entry.additionalDetails),
        achievements: bullets(entry.achievements),
        responsibilities: bullets(entry.responsibilities),
        keyContributions: bullets(entry.keyContributions),
      };
    }),
    education: (account.education ?? []).map((entry, index) => {
      const endDate = partialDate(entry.endDate);
      return {
        id: id('education', index, entry.id),
        name: text(entry.name),
        degreeType: oneOf(
          shape.education.element.shape.degreeType.unwrap().options,
          entry.degreeType,
        ),
        startDate: partialDate(entry.startDate),
        endDate,
        current: current(entry.isPresent, endDate),
        description: paragraphs(entry.additionalDetails),
      };
    }),
    projects: (account.projects ?? []).map((entry, index) => ({
      id: id('projects', index, entry.id),
      name: text(entry.name),
      url: text(entry.url),
      description: paragraphs(entry.additionalDetails),
    })),
    recommendations: (account.recommendations ?? []).map((entry, index) => ({
      id: id('recommendations', index, entry.id),
      name: text(entry.name),
      url: text(entry.url),
      description: paragraphs(entry.additionalDetails),
    })),
    skills: (account.skills ?? []).flatMap((entry, index) => {
      const name = text(entry.name);
      return name ? [{ id: id('skills', index, entry.id), name }] : [];
    }),
    tools: (account.tools ?? []).flatMap((entry, index) => {
      const name = text(entry.name);
      return name ? [{ id: id('tools', index, entry.id), name }] : [];
    }),
    links: (account.links ?? []).flatMap((entry, index) => {
      const value = text(entry.value);
      return value ? [{ id: id('links', index, entry.id), type: text(entry.type), value }] : [];
    }),
    languages: (account.languages ?? []).flatMap((entry, index) => {
      const language = text(entry.language);
      return language
        ? [
            {
              id: id('languages', index, entry.id),
              language,
              proficiency: oneOf(
                shape.languages.element.shape.proficiency.unwrap().options,
                entry.proficiency,
              ),
            },
          ]
        : [];
    }),
  };
  return careerDocumentSchema.parse(document);
}
