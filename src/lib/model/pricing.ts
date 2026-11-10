/*
 * Versioned price table (design §11). Every paid call is priced from this file, and every job
 * records PRICING_VERSION, so a spend figure can always be traced to the rates that produced it.
 * Rates are integer micro-USD per million tokens (or per 1,000 guardrail text units) and costs
 * round up, so the service never under-counts.
 *
 * Basis: Amazon Bedrock on-demand Standard tier, US geographic cross-region inference profiles
 * (the `us.` prefix), invoked from the application Region below. Geographic profiles carry a
 * premium over in-Region rates; no global-profile, caching or volume discount is assumed. Refresh
 * from https://aws.amazon.com/bedrock/pricing/ before a deploy and bump the version when any rate
 * changes. A model without a row here cannot be called.
 */

export const PRICING_VERSION = '2026-11-10.us-geo.1';

export type ModelRates = {
  /** Uncached input tokens, micro-USD per million. */
  inputPerMillion: number;
  /** Output tokens, micro-USD per million. */
  outputPerMillion: number;
};

export const PRICE_TABLE = {
  version: PRICING_VERSION,
  effectiveDate: '2026-11-10',
  source: 'https://aws.amazon.com/bedrock/pricing/',
  sourceRegion: 'us-west-1',
  models: {
    'us.amazon.nova-2-lite-v1:0': { inputPerMillion: 330_000, outputPerMillion: 2_750_000 },
    'us.anthropic.claude-haiku-4-5-20251001-v1:0': {
      inputPerMillion: 1_100_000,
      outputPerMillion: 5_500_000,
    },
  } satisfies Record<string, ModelRates>,
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

export function ratesFor(modelId: string): ModelRates {
  const rates = (PRICE_TABLE.models as Record<string, ModelRates>)[modelId];
  if (!rates) throw new UnpricedModelError();
  return rates;
}

const perMillion = (count: number, rate: number) => Math.ceil((count * rate) / 1_000_000);

export function modelCostMicroUsd(
  modelId: string,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const rates = ratesFor(modelId);
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
