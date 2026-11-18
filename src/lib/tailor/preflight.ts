import { guardrailBound, planCall } from '../model/budget';
import { fixedBytes } from '../model/pack';
import { untrustedText, type SessionInput } from '../prompts/session-input';
import {
  REQUIREMENTS_PACK,
  requirementsMessage,
  TAILOR_PACK,
  worstTailorMessage,
} from '../prompts/tailor';

/**
 * Whether a tailoring job fits its budget at its worst case: the guardrail over the untrusted
 * text, the requirements call, then the largest composition call it can lead to. Admission
 * refuses input that does not fit, so no late section is ever dropped to make it fit.
 */
export function tailorFits(input: SessionInput, budgetMicroUsd: number): boolean {
  const available = budgetMicroUsd - guardrailBound(untrustedText(input).length);
  const first = planCall(
    REQUIREMENTS_PACK.modelId,
    fixedBytes(REQUIREMENTS_PACK) +
      Buffer.byteLength(requirementsMessage(input.jobDescription ?? '')),
    REQUIREMENTS_PACK.outputTokens,
    available,
  );
  if (!first) return false;
  return (
    planCall(
      TAILOR_PACK.modelId,
      fixedBytes(TAILOR_PACK) + Buffer.byteLength(worstTailorMessage(input)),
      TAILOR_PACK.outputTokens,
      available - first.boundMicroUsd,
    ) !== null
  );
}

/** The same worst case in micro-USD, for the golden-set cost gate. */
export function tailorWorstCase(input: SessionInput, budgetMicroUsd: number): number {
  const first = planCall(
    REQUIREMENTS_PACK.modelId,
    fixedBytes(REQUIREMENTS_PACK) +
      Buffer.byteLength(requirementsMessage(input.jobDescription ?? '')),
    REQUIREMENTS_PACK.outputTokens,
    budgetMicroUsd,
  );
  const second = planCall(
    TAILOR_PACK.modelId,
    fixedBytes(TAILOR_PACK) + Buffer.byteLength(worstTailorMessage(input)),
    TAILOR_PACK.outputTokens,
    budgetMicroUsd,
  );
  return (
    guardrailBound(untrustedText(input).length) +
    (first?.boundMicroUsd ?? Infinity) +
    (second?.boundMicroUsd ?? Infinity)
  );
}
