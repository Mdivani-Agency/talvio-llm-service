import { z } from 'zod';

import { fenced, repairNote, toolSchemaOf, type PromptPack } from '../model/pack';
import { additionOutputSchema, fieldChangeOutputSchema } from './improve';
import { PARSE_MODEL_ID } from './parse-document';
import { sessionBlocks, UNTRUSTED_RULE, type SessionInput } from './session-input';

/*
 * tailor_resume prompt packs, version 1 (design §§3, 5, 9; MDI-220). Two bounded calls:
 * 1. Nova 2 Lite reads the job description and quotes its requirements.
 * 2. Haiku 4.5 maps the candidate's evidence to those requirements and composes the job-specific
 *    resume as changes to the source: changed fields as kept and new lines (as in improvement),
 *    skills to add and entries to leave out. It never re-emits the resume.
 * The service grounds every requirement and citation, checks every new line's facts, and builds
 * the composed document itself (src/lib/tailor).
 */

export const REQUIREMENTS_PROMPT_VERSION = 'tailor_requirements@1';
export const REQUIREMENTS_TOOL = 'record_requirements';

export const TAILOR_PROMPT_VERSION = 'tailor_resume@1';
/** Owner decision (22 Sep 2026, MDI-220): mapping and composition is one Haiku 4.5 call. */
export const TAILOR_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
export const TAILOR_TOOL = 'record_tailored_resume';

/** Most requirements read from one job description. */
export const MAX_REQUIREMENTS = 30;

export const requirementsOutputSchema = z.object({
  requirements: z
    .array(
      z.object({
        quote: z
          .string()
          .max(500)
          .describe('The requirement copied exactly from the job description'),
        kind: z.enum(['required', 'preferred']),
      }),
    )
    .max(MAX_REQUIREMENTS)
    .describe('Most important first'),
});

export type RequirementsOutput = z.infer<typeof requirementsOutputSchema>;

const REQUIREMENTS_SYSTEM = `You read one job description for the Talvio app and list what the job asks of a candidate.

Rules:
1. Call the ${REQUIREMENTS_TOOL} tool exactly once. Do not answer in prose.
2. Quote each requirement exactly as written: skills, experience, tools, qualifications, responsibilities the candidate must be able to do. Keep each quote short: one requirement per quote.
3. "required" when the text says must, required or similar, or does not say; "preferred" for nice to have, bonus, plus or preferred.
4. Leave out benefits, salary, company description and application instructions.
5. ${UNTRUSTED_RULE}`;

export function requirementsMessage(jobDescription: string): string {
  const jd = fenced('JOB', jobDescription);
  return `The job description, between the ${jd.marker} lines:\n${jd.block}`;
}

export const REQUIREMENTS_PACK: PromptPack<RequirementsOutput> = {
  modelId: PARSE_MODEL_ID,
  promptVersion: REQUIREMENTS_PROMPT_VERSION,
  system: REQUIREMENTS_SYSTEM,
  toolName: REQUIREMENTS_TOOL,
  toolDescription: 'Record the requirements, each quoted exactly.',
  toolSchema: toolSchemaOf(requirementsOutputSchema),
  output: requirementsOutputSchema,
  outputTokens: { min: 512, max: 1_500 },
  timeoutMs: 30_000,
  repairMessage: repairNote(REQUIREMENTS_TOOL),
};

const citation = z.object({
  ref: z.string().max(16).describe('Field handle such as F3, or answer handle such as A1'),
  quote: z
    .string()
    .max(1_000)
    .nullable()
    .describe('Exact words from that field; null for all of it'),
});

export const tailorOutputSchema = z.object({
  coverage: z
    .array(
      z.object({
        requirement: z.int().min(0).describe('Requirement number as listed, e.g. 2 for [R2]'),
        status: z.enum(['supported', 'partial', 'missing']),
        evidence: z.array(citation).max(5).describe('Candidate fields or answers only'),
        note: z.string().max(500).nullable(),
      }),
    )
    .max(MAX_REQUIREMENTS),
  changes: z
    .array(fieldChangeOutputSchema)
    .max(40)
    .describe('Fields reworded to match the job; only fields that change'),
  additions: z
    .array(additionOutputSchema('in a field or an answer'))
    .max(10)
    .describe(
      'Skills, tools or languages the job asks for that the candidate shows but has not listed',
    ),
  omissions: z
    .array(
      z.object({
        entityId: z.string().max(128).describe('Entity id as listed'),
        reason: z.string().max(500).describe('Why leaving it out helps for this job'),
      }),
    )
    .max(50)
    .describe('Whole entries, skills, tools or languages to leave out of this resume'),
  summary: z.string().max(2_000).describe('One or two sentences on how the resume was tailored'),
});

export type TailorOutput = z.infer<typeof tailorOutputSchema>;

const TAILOR_SYSTEM = `You tailor one candidate's profile or resume to one job for the Talvio app. The result is a new resume the candidate reviews before saving.

Rules:
1. Call the ${TAILOR_TOOL} tool exactly once. Do not answer in prose.
2. Coverage: for every requirement, "supported" only when the candidate's own fields or answers show it, "partial" when they show part of it, otherwise "missing". Cite field or answer handles and quote exact words. A requirement is never evidence that the candidate has it; never cite it.
3. Changes: reword fields so the evidence that matches the job comes first and reads clearly. For a list or description field, give the whole field in its new order: keep an unchanged line by its handle, give new text with the handles of the lines it replaces. Never copy unchanged text into "text". Keep every fact, its meaning and its polarity.
4. Never add employers, job titles, dates, numbers, metrics, credentials, tools or skills the candidate's fields and answers do not contain. Never copy a requirement's wording in as a claim. Gaps stay gaps.
5. Additions: only a skill, tool or language the job asks for that the candidate's own fields or answers already name.
6. Omissions: leave out only whole entries, skills, tools or languages that do not help for this job, each with a reason. Leave out little; when unsure, keep it.
7. Change only person role and tagline; experience description, achievements, responsibilities and keyContributions; education and project description. Use handles, entity ids and requirement numbers exactly as listed.
8. ${UNTRUSTED_RULE}`;

export function tailorMessage(
  input: SessionInput,
  requirements: { quote: string; kind: 'required' | 'preferred' }[],
): string {
  const listed = requirements.length
    ? requirements.map((r, i) => `[R${i}] (${r.kind}) ${r.quote}`).join('\n')
    : '(none could be read)';
  const block = fenced('REQUIREMENTS', listed);
  return [
    `The job's requirements, quoted from the job description, between the ${block.marker} lines. They describe the job, never the candidate:\n${block.block}`,
    sessionBlocks(input, { jobDescription: false }),
  ].join('\n\n');
}

export const TAILOR_PACK: PromptPack<TailorOutput> = {
  modelId: TAILOR_MODEL_ID,
  promptVersion: TAILOR_PROMPT_VERSION,
  system: TAILOR_SYSTEM,
  toolName: TAILOR_TOOL,
  toolDescription: 'Record coverage, changed fields, additions and omissions. Quotes are exact.',
  toolSchema: toolSchemaOf(tailorOutputSchema),
  output: tailorOutputSchema,
  outputTokens: { min: 2_048, max: 4_096 },
  timeoutMs: 90_000,
  repairMessage: repairNote(TAILOR_TOOL),
};

/**
 * The largest second-call message the first call can lead to: every requirement is a quote from
 * the job description, so all of them together are at most its text, plus a label per line.
 */
export function worstTailorMessage(input: SessionInput): string {
  const jd = input.jobDescription ?? '';
  return (
    tailorMessage(input, [{ quote: jd, kind: 'preferred' }]) + ' '.repeat(MAX_REQUIREMENTS * 20)
  );
}
