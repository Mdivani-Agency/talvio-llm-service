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

describe('pricing', () => {
  it('prices tokens in micro-USD, rounding up', () => {
    // Nova 2 Lite, US geographic: USD 0.33 in and USD 2.75 out per million tokens.
    expect(modelCostMicroUsd(PARSE_MODEL_ID, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(
      330_000,
    );
    expect(modelCostMicroUsd(PARSE_MODEL_ID, { inputTokens: 1, outputTokens: 1 })).toBe(1 + 3);
    expect(guardrailCostMicroUsd(100)).toBe(15_000);
  });

  it('has no price, and so no call, for an unlisted model', () => {
    expect(() => ratesFor('global.amazon.nova-2-lite-v1:0')).toThrow(UnpricedModelError);
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
    expect(planCall(PARSE_MODEL_ID, 20_000, OUTPUT_TOKENS, 8_000)).toBeNull();
    const tight = planCall(PARSE_MODEL_ID, 20_000, OUTPUT_TOKENS, 20_000)!;
    expect(tight.maxTokens).toBeLessThan(OUTPUT_TOKENS.max);
    expect(tight.boundMicroUsd).toBeLessThanOrEqual(20_000);
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
