import { careerDocumentSchema, jobDescriptionSchema } from '@talvio/llm-contracts';

import { SESSION_GOLDEN } from '../../test/fixtures/session-golden';
import { careerView } from '../career/view';
import { ANALYZE_PACK, analysisMessage } from '../prompts/analyze-resume';
import { QUESTIONS_PACK, questionsMessage } from '../prompts/generate-questions';
import { untrustedText, type SessionInput } from '../prompts/session-input';
import { guardrailBound, planCall } from './budget';
import { fixedBytes, type PromptPack } from './pack';
import { callFits } from './preflight';

/*
 * The cost side of MDI-218's acceptance, checked offline: on the golden set the worst case of
 * one analysis or questions call (guardrail plus the full output allocation) stays at or below
 * the USD 0.04 p95 target, so typical inputs never fail on budget and the USD 0.05 cap holds.
 * Metered cost against real Bedrock is measured by `yarn smoke:bedrock`.
 */

const CAP = 50_000;
const P95_TARGET = 40_000;

const worstCase = (pack: PromptPack<unknown>, user: string, guarded: string) => {
  const plan = planCall(
    pack.modelId,
    fixedBytes(pack) + Buffer.byteLength(user),
    pack.outputTokens,
    CAP,
  );
  return guardrailBound(guarded.length) + (plan?.boundMicroUsd ?? Infinity);
};

describe.each(SESSION_GOLDEN)('golden fixture $name', ({ source, jobDescription }) => {
  careerDocumentSchema.parse(source.document);
  if (jobDescription) jobDescriptionSchema.parse(jobDescription);
  const input: SessionInput = {
    view: careerView(source.document),
    jobDescription: jobDescription?.text ?? null,
    answers: [],
  };
  const guarded = untrustedText(input);

  it('fits analysis within the p95 target at its worst case', () => {
    const user = analysisMessage(input, []);
    expect(callFits(ANALYZE_PACK, user, guarded.length, CAP)).toBe(true);
    expect(worstCase(ANALYZE_PACK, user, guarded)).toBeLessThanOrEqual(P95_TARGET);
  });

  it('fits questions within the p95 target at its worst case', () => {
    const user = questionsMessage({ ...input, maxQuestions: 5, analysis: null, askedTopics: [] });
    expect(callFits(QUESTIONS_PACK, user, guarded.length, CAP)).toBe(true);
    expect(worstCase(QUESTIONS_PACK, user, guarded)).toBeLessThanOrEqual(P95_TARGET);
  });
});
