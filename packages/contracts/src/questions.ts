import { z } from 'zod';

import { careerSectionEnum } from './career';
import { LIMITS } from './limits';
import { duplicateIds, stableIdSchema, uuidSchema } from './primitives';

/*
 * Gap questions (design §12). Question IDs are issued by the server and stay stable for the
 * session; answers and skips are keyed by question ID, never by position.
 */

export const questionSchema = z.strictObject({
  id: stableIdSchema,
  /** Topic used to avoid re-asking a known or skipped fact in the same session. */
  topicKey: z
    .string()
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
    .max(64),
  prompt: z.string().min(1).max(500),
  /** Neutral guidance on what a useful answer contains; never a suggested answer. */
  guidance: z.string().max(500).nullable(),
  /** Why the question matters, shown to the user. */
  reason: z.string().max(500),
  targetSection: careerSectionEnum.nullable(),
  targetEntityId: stableIdSchema.nullable(),
  requirementIds: z.array(stableIdSchema).max(10),
});

export const questionSetSchema = z.strictObject({
  questionSetId: uuidSchema,
  round: z.int().min(1).max(LIMITS.questionRoundsPerSession),
  questions: z
    .array(questionSchema)
    .max(LIMITS.questionsPerSet)
    .refine((questions) => duplicateIds(questions.map((question) => question.id)).length === 0, {
      message: 'question ids must be unique',
    }),
});

export const answerStatusEnum = z.enum(['answered', 'skipped']);

export const answerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    questionId: stableIdSchema,
    status: z.literal('answered'),
    value: z.string().trim().min(1).max(LIMITS.answerChars),
  }),
  z.strictObject({
    questionId: stableIdSchema,
    status: z.literal('skipped'),
  }),
]);

export type Question = z.infer<typeof questionSchema>;
export type QuestionSet = z.infer<typeof questionSetSchema>;
export type Answer = z.infer<typeof answerSchema>;
