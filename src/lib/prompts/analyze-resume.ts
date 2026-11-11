import { z } from 'zod';

import { careerSectionEnum } from '@talvio/llm-contracts';

import { repairNote, toolSchemaOf, type PromptPack } from '../model/pack';
import { PARSE_MODEL_ID } from './parse-document';
import { sessionBlocks, UNTRUSTED_RULE, type SessionInput } from './session-input';

/*
 * analyze_resume prompt pack, version 1 (design §§5, 9). One call returns findings and, with a job
 * description, its requirements and how the candidate's own text covers each. The model cites
 * field handles and quotes; the service grounds every citation and drops what it cannot find
 * (src/lib/analysis). Job requirements are quoted from the job description and can never be
 * evidence for the candidate.
 */

export const ANALYZE_PROMPT_VERSION = 'analyze_resume@1';

/** Same model as parsing (owner decision, 22 Sep 2026): Nova 2 Lite, forced single-tool JSON. */
export const ANALYZE_MODEL_ID = PARSE_MODEL_ID;

export const ANALYZE_TOOL = 'record_analysis';

const citation = z.object({
  ref: z.string().max(16).describe('Field handle such as F3, or answer handle such as A1'),
  quote: z
    .string()
    .max(1_000)
    .nullable()
    .describe('Exact words from that field; null for all of it'),
});

export const analysisOutputSchema = z.object({
  requirements: z
    .array(
      z.object({
        quote: z
          .string()
          .max(1_000)
          .describe('The requirement copied exactly from the job description'),
        kind: z.enum(['required', 'preferred']),
      }),
    )
    .max(40)
    .describe('Empty when there is no job description'),
  coverage: z
    .array(
      z.object({
        requirement: z.int().min(0).describe('Index into requirements'),
        status: z.enum(['supported', 'partial', 'missing']),
        evidence: z.array(citation).max(5).describe('Candidate fields or answers only'),
        note: z.string().max(500).nullable(),
      }),
    )
    .max(40),
  findings: z
    .array(
      z.object({
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
        entityId: z.string().max(128).nullable(),
        message: z.string().max(500),
        evidence: z.array(citation).max(5),
        requirement: z.int().min(0).nullable().describe('Index into requirements, for job_match'),
      }),
    )
    .max(40)
    .describe('Most important first'),
});

export type AnalysisOutput = z.infer<typeof analysisOutputSchema>;

const SYSTEM = `You review one candidate's profile or resume for the Talvio app and, when a job description is given, compare the candidate with it.

Rules:
1. Call the ${ANALYZE_TOOL} tool exactly once. Do not answer in prose.
2. Findings say what is missing, unclear, unsupported, inconsistent or weak, and why it matters. Put the most important first: relevance to the job, then how much evidence is missing, then how easy it is to fix.
3. Cite evidence by field handle ([F3]) or answer handle ([A1]) and quote the exact words. Never cite text that is not there.
4. Requirements are quoted exactly from the job description. They describe the job, never the candidate: a requirement is never evidence that the candidate has it.
5. Coverage is "supported" only when the candidate's own fields or answers show it, "partial" when they show part of it, otherwise "missing". Explain unsupported requirements in the note.
6. Do not invent facts, numbers, employers, dates, skills or credentials. Do not give scores, percentages or ATS ratings.
7. ${UNTRUSTED_RULE}`;

export function analysisMessage(input: SessionInput, sections: string[]): string {
  const scope = sections.length
    ? `Analyze only these sections: ${sections.join(', ')}.`
    : 'Analyze every section.';
  return `${scope}\n\n${sessionBlocks(input)}`;
}

export const ANALYZE_PACK: PromptPack<AnalysisOutput> = {
  modelId: ANALYZE_MODEL_ID,
  promptVersion: ANALYZE_PROMPT_VERSION,
  system: SYSTEM,
  toolName: ANALYZE_TOOL,
  toolDescription: 'Record the findings, requirements and coverage. Quotes are exact.',
  toolSchema: toolSchemaOf(analysisOutputSchema),
  output: analysisOutputSchema,
  outputTokens: { min: 2_048, max: 6_000 },
  timeoutMs: 60_000,
  repairMessage: repairNote(ANALYZE_TOOL),
};
