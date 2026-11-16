import { FIXED_REQUEST_BYTES, OUTPUT_TOKENS, PARSE_MODEL_ID } from '../prompts/parse-document';
import { guardrailBound, planCall } from './budget';
import { fixedBytes, type PromptPack } from './pack';

/*
 * Admission preflight (design §11 step 2): text whose worst case cannot fit the job budget is
 * refused before a job exists, with no model call and no quota taken. The worker checks again
 * against the exact text before each call; this check only has to be no looser than that one.
 */

/** UTF-8 bytes of a text of `chars` UTF-16 units, when only the length is known. */
export const maxUtf8Bytes = (chars: number) => chars * 3;

export function parseFits(text: { chars: number; bytes: number }, budgetMicroUsd: number): boolean {
  const available = budgetMicroUsd - guardrailBound(text.chars);
  return (
    planCall(PARSE_MODEL_ID, FIXED_REQUEST_BYTES + text.bytes, OUTPUT_TOKENS, available) !== null
  );
}

/** Whether one call of `pack` with `userText`, after guarding `guardedChars`, fits the budget. */
export function callFits(
  pack: PromptPack<unknown>,
  userText: string,
  guardedChars: number,
  budgetMicroUsd: number,
): boolean {
  const available = budgetMicroUsd - guardrailBound(guardedChars);
  return (
    planCall(
      pack.modelId,
      fixedBytes(pack) + Buffer.byteLength(userText),
      pack.outputTokens,
      available,
    ) !== null
  );
}
