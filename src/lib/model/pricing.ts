/*
 * Versioned price table (design §11). Every paid call is priced from this file, and every job
 * records PRICING_VERSION, so a spend figure can always be traced to the rates that produced it.
 * Rates are integer micro-USD per million tokens (or per 1,000 guardrail text units) and costs
 * round up, so the service never under-counts.
 *
 * Claude models (MDI-638): Claude API standard rates, with no batch, caching or priority discount
 * assumed. Claude Haiku 5.5 has a second rate card for prompts over 100K input tokens: a call is
 * priced on that card whenever its input is over the threshold, and bounded on it whenever its
 * input bound is. Source: https://platform.claude.com/docs/en/about-claude/pricing.
 *
 * Bedrock models and the input guardrail: on-demand Standard tier, US geographic cross-region
 * inference profiles (the `us.` prefix), invoked from us-west-1. Geographic profiles carry a
 * premium over in-Region rates. Source: https://aws.amazon.com/bedrock/pricing/.
 *
 * Refresh before a deploy and bump the version when any rate changes. A model without a row here
 * cannot be called.
 */

export const PRICING_VERSION = '2026-11-16.1';

export type ModelRates = {
  /** Uncached input tokens, micro-USD per million. */
  inputPerMillion: number;
  /** Output tokens, micro-USD per million. */
  outputPerMillion: number;
};

export type ModelPrice = ModelRates & {
  /** Rates for the whole call once its input tokens exceed `aboveInputTokens`. */
  longContext?: ModelRates & { aboveInputTokens: number };
};

export const PRICE_TABLE = {
  version: PRICING_VERSION,
  effectiveDate: '2026-11-16',
  models: {
    'claude-haiku-5-5': {
      inputPerMillion: 100_000,
      outputPerMillion: 500_000,
      longContext: {
        aboveInputTokens: 100_000,
        inputPerMillion: 500_000,
        outputPerMillion: 2_500_000,
      },
    },
    'us.amazon.nova-2-lite-v1:0': { inputPerMillion: 330_000, outputPerMillion: 2_750_000 },
    'us.anthropic.claude-haiku-4-5-20251001-v1:0': {
      inputPerMillion: 1_100_000,
      outputPerMillion: 5_500_000,
    },
  } satisfies Record<string, ModelPrice>,
  /** ApplyGuardrail content filters: USD 0.15 per 1,000 text units of up to 1,000 characters. */
  guardrail: { perThousandUnits: 150_000, unitChars: 1_000 },
} as const;

export type PricedModel = keyof typeof PRICE_TABLE.models;

export class UnpricedModelError extends Error {
  constructor() {
    super('model has no price');
    this.name = 'UnpricedModelError';
  }
}

/** The rate card a call with `inputTokens` of input is billed on. */
export function ratesFor(modelId: string, inputTokens: number): ModelRates {
  const price = (PRICE_TABLE.models as Record<string, ModelPrice>)[modelId];
  if (!price) throw new UnpricedModelError();
  const long = price.longContext;
  return long && inputTokens > long.aboveInputTokens ? long : price;
}

const perMillion = (count: number, rate: number) => Math.ceil((count * rate) / 1_000_000);

export function modelCostMicroUsd(
  modelId: string,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const rates = ratesFor(modelId, usage.inputTokens);
  return (
    perMillion(usage.inputTokens, rates.inputPerMillion) +
    perMillion(usage.outputTokens, rates.outputPerMillion)
  );
}

/** Text units of one guardrail request: each started 1,000 characters is a unit. */
export const guardrailUnits = (chars: number) =>
  Math.max(1, Math.ceil(chars / PRICE_TABLE.guardrail.unitChars));

export const guardrailCostMicroUsd = (units: number) =>
  Math.ceil((units * PRICE_TABLE.guardrail.perThousandUnits) / 1_000);
