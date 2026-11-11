import { z } from 'zod';

import { careerSectionEnum, type OperationResult } from '@talvio/llm-contracts';

import { repairNote, toolSchemaOf, type PromptPack } from '../model/pack';
import { PARSE_MODEL_ID } from './parse-document';
import { sessionBlocks, UNTRUSTED_RULE, type SessionInput } from './session-input';

/*
 * generate_questions prompt pack, version 1 (design §§3, 12). Zero to five questions about real
 * gaps in the candidate's source, optionally guided by an earlier analysis. The service drops
 * questions on topics already asked in the session, questions that state numbers the source does
 * not contain and questions that point at nothing in the source or the analysis
 * (src/lib/questions).
 */

export const QUESTIONS_PROMPT_VERSION = 'generate_questions@1';
export const QUESTIONS_MODEL_ID = PARSE_MODEL_ID;
export const QUESTIONS_TOOL = 'record_questions';

export const questionsOutputSchema = z.object({
  questions: z
    .array(
      z.object({
        topicKey: z
          .string()
          .max(64)
          .describe('Short lowercase key for the fact asked about, e.g. "experience.team-size"'),
        prompt: z.string().max(500).describe('The question, addressed to the candidate'),
        guidance: z
          .string()
          .max(500)
          .nullable()
          .describe('What a useful answer contains, without suggesting an answer or a number'),
        reason: z.string().max(500).describe('Why this matters, shown to the candidate'),
        targetSection: careerSectionEnum.nullable(),
        targetEntityId: z.string().max(128).nullable(),
        findingId: z
          .string()
          .max(128)
          .nullable()
          .describe('The analysis finding it closes, if any'),
        requirementIds: z.array(z.string().max(128)).max(10),
      }),
    )
    .max(10)
    .describe('Most useful first; an empty list is a valid answer'),
});

export type QuestionsOutput = z.infer<typeof questionsOutputSchema>;

const SYSTEM = `You write follow-up questions for one candidate in the Talvio app, so their profile or resume can be improved with facts only they know.

Rules:
1. Call the ${QUESTIONS_TOOL} tool exactly once. Do not answer in prose.
2. Ask only about real gaps: something missing, vague or unsupported in the candidate's own text, or a job requirement their text does not show. If nothing useful is left to ask, return no questions.
3. Never ask about anything the source or the answers already state, or about a topic listed as already asked.
4. Put the most useful questions first: relevance to the job, then how much evidence is missing, then how easy it is to answer.
5. Never suggest an answer. Never put a number, percentage or amount in a question or its guidance unless it is quoted from the candidate's text.
6. Do not ask for contact details, other people's names, or sensitive personal data.
7. Use the field entity ids, finding ids and requirement ids exactly as listed, or null.
8. ${UNTRUSTED_RULE}`;

export type QuestionsPromptInput = SessionInput & {
  maxQuestions: number;
  analysis: OperationResult<'analyze_resume'> | null;
  askedTopics: { topicKey: string; status: 'answered' | 'skipped' | 'unanswered' }[];
};

export function questionsMessage(input: QuestionsPromptInput): string {
  const parts = [`Write at most ${input.maxQuestions} questions.`];
  if (input.askedTopics.length) {
    parts.push(
      `Topics already asked in this session (never ask again):\n${input.askedTopics
        .map((t) => `- ${t.topicKey} (${t.status})`)
        .join('\n')}`,
    );
  }
  if (input.analysis) {
    const { findings, requirements, coverage } = input.analysis;
    const status = new Map(coverage.map((c) => [c.requirementId, c.status]));
    parts.push(
      `An earlier analysis of this source (its quotes come from the data below):\nFindings:\n${
        findings
          .map(
            (f) =>
              `- ${f.id} [${f.severity}, ${f.category}, ${f.section ?? 'general'}${f.entityId ? ` ${f.entityId}` : ''}] ${f.message}`,
          )
          .join('\n') || '- none'
      }\nRequirements:\n${
        requirements
          .map((r) => `- ${r.id} [${r.kind}, ${status.get(r.id) ?? 'missing'}] ${r.text}`)
          .join('\n') || '- none'
      }`,
    );
  }
  parts.push(sessionBlocks(input));
  return parts.join('\n\n');
}

export const QUESTIONS_PACK: PromptPack<QuestionsOutput> = {
  modelId: QUESTIONS_MODEL_ID,
  promptVersion: QUESTIONS_PROMPT_VERSION,
  system: SYSTEM,
  toolName: QUESTIONS_TOOL,
  toolDescription: 'Record the follow-up questions, most useful first.',
  toolSchema: toolSchemaOf(questionsOutputSchema),
  output: questionsOutputSchema,
  outputTokens: { min: 1_024, max: 3_000 },
  timeoutMs: 45_000,
  repairMessage: repairNote(QUESTIONS_TOOL),
};
