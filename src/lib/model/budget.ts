import { guardrailCostMicroUsd, guardrailUnits, ratesFor } from './pricing';

/*
 * Spending bounds (design §11). Nothing is called before its worst case is known and fits.
 *
 * Input bound. Nova 2 Lite has no CountTokens, so the bound is the request's UTF-8 size: every
 * token of a byte-level tokenizer covers at least one byte, and serialized JSON (the tool schema,
 * escapes) only adds bytes. A fixed allowance covers the chat template's special tokens. This is
 * an upper bound, never an estimate of the likely count, and it holds for any text. Haiku 4.5
 * (tailoring) uses the same bound: its tokenizer is byte-level too.
 */

/** Tokens the provider may add around messages, the tool and the system prompt. */
export const TEMPLATE_TOKENS = 1_024;

export const inputTokenBound = (requestBytes: number) => requestBytes + TEMPLATE_TOKENS;

/** Characters per guardrail request; bounded so each request stays small (design §10). */
export const GUARDRAIL_CHUNK_CHARS = 20_000;
/** Overlap between chunks, so no passage is evaluated only in halves. */
export const GUARDRAIL_OVERLAP_CHARS = 500;

/** The text split into the guardrail requests that will check it; every character is in one. */
export function guardrailChunks(text: string): string[] {
  if (text.length <= GUARDRAIL_CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  const step = GUARDRAIL_CHUNK_CHARS - GUARDRAIL_OVERLAP_CHARS;
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + GUARDRAIL_CHUNK_CHARS));
    if (start + GUARDRAIL_CHUNK_CHARS >= text.length) break;
  }
  return chunks;
}

/** Worst-case guardrail charge for text of `length` characters: each request rounds up separately. */
export function guardrailBound(length: number): number {
  let total = 0;
  const step = GUARDRAIL_CHUNK_CHARS - GUARDRAIL_OVERLAP_CHARS;
  for (let start = 0; ; start += step) {
    const size = Math.min(GUARDRAIL_CHUNK_CHARS, length - start);
    total += guardrailCostMicroUsd(guardrailUnits(size));
    if (start + GUARDRAIL_CHUNK_CHARS >= length) return total;
  }
}

export type CallPlan = { maxTokens: number; boundMicroUsd: number };

/**
 * The largest output allocation in [min, max] whose worst case fits `availableMicroUsd`, or null
 * when even the minimum does not fit. The bound is input at its upper bound plus the full output.
 */
export function planCall(
  modelId: string,
  requestBytes: number,
  output: { min: number; max: number },
  availableMicroUsd: number,
): CallPlan | null {
  const rates = ratesFor(modelId);
  const input = Math.ceil((inputTokenBound(requestBytes) * rates.inputPerMillion) / 1_000_000);
  const outputCost = (tokens: number) => Math.ceil((tokens * rates.outputPerMillion) / 1_000_000);
  const affordable = Math.floor(((availableMicroUsd - input) * 1_000_000) / rates.outputPerMillion);
  const maxTokens = Math.min(output.max, affordable);
  if (maxTokens < output.min) return null;
  return { maxTokens, boundMicroUsd: input + outputCost(maxTokens) };
}

export { spentMicroUsd, nextEntry, reserved, settled, type Ledger } from '../ledger';
