import { z } from 'zod';

import type { OperationInput } from '@talvio/llm-contracts';

import { fenced, repairNote, toolSchemaOf, type PromptPack } from '../model/pack';
import { PARSE_MODEL_ID } from './parse-document';
import { sessionBlocks, UNTRUSTED_RULE, type SessionInput } from './session-input';

/*
 * improve_profile / improve_resume prompt pack, version 1 (design §§5, 9). The model returns only
 * the fields it changes, as a compact list of lines: each line keeps an original line by handle or
 * gives new text with the handles it rewrites. It never re-emits unchanged text. The service
 * restores anything the model leaves out, checks every new line's facts against the source and the
 * user's answers, and builds the reviewable proposal (src/lib/improve).
 */

export const IMPROVE_PROMPT_VERSION = 'improve@1';
export const IMPROVE_MODEL_ID = PARSE_MODEL_ID;
export const IMPROVE_TOOL = 'record_improvements';

/** Fields the model may change; they match the contract's TARGETABLE_FIELDS. */
export const IMPROVE_FIELDS = [
  'role',
  'tagline',
  'description',
  'achievements',
  'responsibilities',
  'keyContributions',
] as const;

/** One changed field: kept lines by handle and new lines with the handles they replace. */
export const fieldChangeOutputSchema = z.object({
  entityId: z.string().max(128).nullable().describe('Entity id as listed; null for person'),
  field: z.enum(IMPROVE_FIELDS),
  value: z
    .string()
    .max(5_000)
    .nullable()
    .describe('New text for role or tagline; null for list and description fields'),
  lines: z
    .array(
      z.object({
        keep: z
          .string()
          .max(16)
          .nullable()
          .describe('Handle of an original line kept word for word, e.g. F7'),
        text: z.string().max(5_000).nullable().describe('New text; null when keeping'),
        from: z
          .array(z.string().max(16))
          .max(10)
          .describe('Handles of the original lines this new text replaces'),
        style: z
          .enum(['paragraph', 'bullet'])
          .nullable()
          .describe('Description lines only: paragraph or bullet'),
      }),
    )
    .max(30)
    .describe('The whole field in its new order: kept lines by handle, new lines as text'),
  reason: z.string().max(500).describe('Why this change helps, shown to the candidate'),
});

export const additionOutputSchema = (where: string) =>
  z.object({
    section: z.enum(['skills', 'tools', 'languages']),
    name: z.string().max(300).describe(`Exactly as the candidate wrote it ${where}`),
    reason: z.string().max(500),
  });

export const improveOutputSchema = z.object({
  changes: z
    .array(fieldChangeOutputSchema)
    .max(40)
    .describe('Only fields that change; an empty list is a valid answer'),
  additions: z
    .array(additionOutputSchema('in an answer'))
    .max(10)
    .describe('Only items the candidate named in an answer'),
  summary: z.string().max(2_000).describe('One or two sentences on what the changes do'),
});

export type ImproveOutput = z.infer<typeof improveOutputSchema>;

const SYSTEM = `You improve one candidate's profile or resume for the Talvio app. The candidate reviews every change before anything is saved.

Rules:
1. Call the ${IMPROVE_TOOL} tool exactly once. Do not answer in prose.
2. Return only fields you change. For a list or description field, give the whole field in its new order: keep an unchanged line by its handle, and give new text with the handles of the lines it replaces. Never copy unchanged text into "text".
3. Improve wording: clear, concise, active, results first. Keep every fact, its meaning and its polarity ("helped with" stays "helped with").
4. Never add employers, job titles, dates, numbers, metrics, credentials, tools or skills that are not in the candidate's own fields or answers. Never use the job description or the target role as a source of facts.
5. A fact from an answer may be added to the field it belongs to; skills, tools and languages named in answers go under additions.
6. Change only these fields: person role and tagline; experience description, achievements, responsibilities and keyContributions; education and project description.
7. Use handles and entity ids exactly as listed.
8. ${UNTRUSTED_RULE}`;

export type TargetSection = OperationInput<'improve_profile'>['sections'][number];

export type ImprovePromptInput = SessionInput & {
  sections: TargetSection[];
  targetRole: string | null;
};

export function improveMessage(input: ImprovePromptInput): string {
  const parts = [
    input.sections.length
      ? `Improve only these sections: ${input.sections.join(', ')}.`
      : 'Improve any section that needs it.',
  ];
  if (input.targetRole) {
    const role = fenced('ROLE', input.targetRole);
    parts.push(
      `The target role, for emphasis only and never a fact about the candidate, between the ${role.marker} lines:\n${role.block}`,
    );
  }
  parts.push(sessionBlocks(input));
  return parts.join('\n\n');
}

/** What the input guardrail checks: the session's untrusted text plus the target role. */
export function improveGuardText(untrusted: string, targetRole: string | null): string {
  return [untrusted, targetRole ?? ''].filter(Boolean).join('\n\n');
}

export const IMPROVE_PACK: PromptPack<ImproveOutput> = {
  modelId: IMPROVE_MODEL_ID,
  promptVersion: IMPROVE_PROMPT_VERSION,
  system: SYSTEM,
  toolName: IMPROVE_TOOL,
  toolDescription: 'Record the changed fields as kept and new lines, and any additions.',
  toolSchema: toolSchemaOf(improveOutputSchema),
  output: improveOutputSchema,
  outputTokens: { min: 2_048, max: 6_000 },
  timeoutMs: 60_000,
  repairMessage: repairNote(IMPROVE_TOOL),
};
