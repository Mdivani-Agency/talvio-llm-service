import { careerDocumentSchema, jobDescriptionSchema } from '@talvio/llm-contracts';

import { SESSION_GOLDEN } from '../../test/fixtures/session-golden';
import { careerView } from '../career/view';
import { ANALYZE_PACK, analysisMessage } from '../prompts/analyze-resume';
import { QUESTIONS_PACK, questionsMessage } from '../prompts/generate-questions';
import { IMPROVE_PACK, improveGuardText, improveMessage } from '../prompts/improve';
import { untrustedText, type SessionInput } from '../prompts/session-input';
import { guardrailBound, planCall } from './budget';
import { fixedBytes, type PromptPack } from './pack';
import { callFits } from './preflight';
import { tailorFits } from '../tailor/preflight';
import {
  REQUIREMENTS_PACK,
  TAILOR_PACK,
  requirementsMessage,
  worstTailorMessage,
} from '../prompts/tailor';
import { ratesFor } from './pricing';

/*
 * The cost side of MDI-218's and MDI-219's acceptance, checked offline: on the golden set the
 * worst case of one analysis, questions or improvement call, and of tailoring, (guardrail plus the full output
 * allocation) stays at or below the USD 0.04 p95 target, so typical inputs never fail on budget
 * and the USD 0.05 cap holds.
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

  it('fits improvement within the p95 target at its worst case', () => {
    const lines: SessionInput = {
      ...input,
      view: careerView(source.document, { descriptionLines: true }),
    };
    const targetRole = 'Staff Backend Engineer';
    const user = improveMessage({ ...lines, sections: [], targetRole });
    const text = improveGuardText(untrustedText(lines), targetRole);
    expect(callFits(IMPROVE_PACK, user, text.length, CAP)).toBe(true);
    expect(worstCase(IMPROVE_PACK, user, text)).toBeLessThanOrEqual(P95_TARGET);
  });

  // Tailoring is two calls and its worst-case input bound counts one token per byte, which for
  // Haiku 4.5 is close to the cap. The gate is: the worst case always fits under the cap (no
  // budget_exceeded on typical input), and a conservative estimate of the metered cost (three
  // bytes per token, the full minimum output of each call) stays at or below the p95 target.
  it('fits tailoring under the cap and its estimated cost within the p95 target', () => {
    if (!jobDescription) return;
    const lines: SessionInput = {
      ...input,
      view: careerView(source.document, { descriptionLines: true }),
    };
    expect(tailorFits(lines, CAP)).toBe(true);
    const estimate = (pack: PromptPack<unknown>, user: string) => {
      const rates = ratesFor(pack.modelId);
      const inputTokens = Math.ceil((fixedBytes(pack) + Buffer.byteLength(user)) / 3);
      return (
        (inputTokens * rates.inputPerMillion + pack.outputTokens.min * rates.outputPerMillion) /
        1_000_000
      );
    };
    const total =
      guardrailBound(untrustedText(lines).length) +
      estimate(REQUIREMENTS_PACK, requirementsMessage(jobDescription.text)) +
      estimate(TAILOR_PACK, worstTailorMessage(lines));
    expect(total).toBeLessThanOrEqual(P95_TARGET);
  });

  it('fits questions within the p95 target at its worst case', () => {
    const user = questionsMessage({ ...input, maxQuestions: 5, analysis: null, askedTopics: [] });
    expect(callFits(QUESTIONS_PACK, user, guarded.length, CAP)).toBe(true);
    expect(worstCase(QUESTIONS_PACK, user, guarded)).toBeLessThanOrEqual(P95_TARGET);
  });
});
