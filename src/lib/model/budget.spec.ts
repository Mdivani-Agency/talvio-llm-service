import { LIMITS } from '@talvio/llm-contracts';

import {
  GUARDRAIL_CHUNK_CHARS,
  guardrailBound,
  guardrailChunks,
  nextEntry,
  planCall,
  reserved,
  settled,
  spentMicroUsd,
} from './budget';
import { parseFits } from './preflight';
import { guardrailCostMicroUsd, modelCostMicroUsd, ratesFor, UnpricedModelError } from './pricing';
import { OUTPUT_TOKENS, PARSE_MODEL_ID } from '../prompts/parse-document';
import { GOLDEN } from '../../test/fixtures/golden';

const CAP = 50_000;
const NOVA = 'us.amazon.nova-2-lite-v1:0';

describe('pricing', () => {
  it('prices tokens in micro-USD, rounding up', () => {
    // Nova 2 Lite, US geographic: USD 0.33 in and USD 2.75 out per million tokens.
    expect(modelCostMicroUsd(NOVA, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(330_000);
    expect(modelCostMicroUsd(NOVA, { inputTokens: 1, outputTokens: 1 })).toBe(1 + 3);
    expect(guardrailCostMicroUsd(100)).toBe(15_000);
  });

  it('prices Claude Haiku 5.5 on its long-context card above 100K input tokens', () => {
    // USD 0.10 in and 0.50 out per million up to 100K input tokens; USD 0.50 and 2.50 above.
    expect(
      modelCostMicroUsd('claude-haiku-5-5', { inputTokens: 100_000, outputTokens: 10_000 }),
    ).toBe(10_000 + 5_000);
    expect(
      modelCostMicroUsd('claude-haiku-5-5', { inputTokens: 100_001, outputTokens: 10_000 }),
    ).toBe(50_001 + 25_000);
  });

  it('bounds a call on the long-context card when its input bound is over the threshold', () => {
    const output = { min: 1_000, max: 1_000 };
    const short = planCall('claude-haiku-5-5', 50_000, output, 1_000_000)!;
    // 51,024 tokens at USD 0.10 per million, plus 1,000 at USD 0.50.
    expect(short.boundMicroUsd).toBe(5_103 + 500);
    const long = planCall('claude-haiku-5-5', 100_000, output, 1_000_000)!;
    // 101,024 tokens: the whole call moves to USD 0.50 and 2.50 per million.
    expect(long.boundMicroUsd).toBe(50_512 + 2_500);
  });

  it('has no price, and so no call, for an unlisted model', () => {
    expect(() => ratesFor('global.amazon.nova-2-lite-v1:0', 0)).toThrow(UnpricedModelError);
  });
});

describe('guardrail bounds', () => {
  it('splits long text into overlapping chunks that cover every character', () => {
    const text = 'x'.repeat(50_000);
    const chunks = guardrailChunks(text);
    expect(chunks.every((chunk) => chunk.length <= GUARDRAIL_CHUNK_CHARS)).toBe(true);
    expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBeGreaterThanOrEqual(
      text.length,
    );
    expect(guardrailBound(text.length)).toBe(
      chunks.reduce(
        (sum, chunk) => sum + guardrailCostMicroUsd(Math.ceil(chunk.length / 1_000)),
        0,
      ),
    );
  });
});

describe('planCall', () => {
  it('gives the largest output that fits, and none below the minimum', () => {
    const plan = planCall(PARSE_MODEL_ID, 20_000, OUTPUT_TOKENS, CAP);
    expect(plan?.maxTokens).toBe(OUTPUT_TOKENS.max);
    expect(plan!.boundMicroUsd).toBeLessThanOrEqual(CAP);
    expect(planCall(PARSE_MODEL_ID, 20_000, OUTPUT_TOKENS, 4_000)).toBeNull();
    const tight = planCall(PARSE_MODEL_ID, 20_000, OUTPUT_TOKENS, 6_000)!;
    expect(tight.maxTokens).toBeLessThan(OUTPUT_TOKENS.max);
    expect(tight.boundMicroUsd).toBeLessThanOrEqual(6_000);
  });
});

describe('admission preflight', () => {
  const sized = (text: string) => ({ chars: text.length, bytes: Buffer.byteLength(text) });

  it('admits typical resumes, including long non-Latin ones', () => {
    expect(parseFits(sized('Engineer. '.repeat(1_500)), CAP)).toBe(true);
    expect(parseFits(sized('ინჟინერი. '.repeat(1_200)), CAP)).toBe(true);
  });

  it('admits every golden-set fixture: typical lengths never fail on budget', () => {
    for (const fixture of GOLDEN) {
      expect(parseFits(sized(fixture.text), CAP)).toBe(true);
    }
  });

  it('refuses text at the product limit whose worst case cannot fit the cap', () => {
    expect(parseFits(sized('a'.repeat(LIMITS.sourceTextChars)), CAP)).toBe(false);
  });
});

describe('spend ledger', () => {
  it('counts settled calls at their actual charge and open ones at their bound', () => {
    const ledger = {
      safeguard: { 'spend.1': settled(1_500, 1_200), passed: 'x' },
      inference: { 'spend.1': settled(30_000, 9_000), 'spend.2': reserved(30_000) },
    };
    expect(spentMicroUsd(ledger)).toBe(1_200 + 9_000 + 30_000);
    expect(nextEntry(ledger.inference)).toBe('spend.3');
  });
});
