import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { loadConfig } from '../lib/config';
import { createModelDeps } from '../lib/model/providers';
import { DOCUMENTS, JOBS } from './fixtures';
import { PERSONAS } from './personas';
import { evaluate } from './run';

/*
 * Release evaluation against the real providers (MDI-223, MDI-638, design §14). Skipped unless
 * LLM_EVAL=1. Run it before a prompt, model or pipeline release, with AWS credentials for the
 * target account (the pinned guardrail stays on Bedrock) and a Claude API key in the shell:
 *
 *   LLM_EVAL=1 BEDROCK_REGION=us-west-1 GUARDRAIL_ID=... GUARDRAIL_VERSION=... \
 *     ANTHROPIC_API_KEY=... yarn eval:live
 *
 * It runs 74 parses, 20 tailoring sessions (analysis, questions, tailoring) and 12 improvements,
 * about 146 jobs. At the USD 0.04 p95 target that is under USD 6 of model and guardrail spend.
 *
 * It writes to EVAL_OUT (default eval-out/, git-ignored):
 * - report.json: the content-free report and every gate's status;
 * - questions.json: the generated questions (synthetic, like the whole set) for people to rate.
 * Until every question is rated, the usefulness gate stays pending and the release is not cleared.
 * Rate this run's questions with `yarn eval:rate` (rate.live.spec.ts), not by running again: a new
 * run asks different questions. EVAL_RATINGS here still applies ratings in the same run.
 */

const enabled = process.env.LLM_EVAL === '1';
const suite = enabled ? describe : describe.skip;

suite('release evaluation', () => {
  jest.setTimeout(3_600_000);

  it('meets every release gate on the evaluation set', async () => {
    const config = loadConfig({
      STAGE: 'test',
      SUPABASE_URL: 'https://eval.invalid',
      ...process.env,
    });
    const out = process.env.EVAL_OUT ?? 'eval-out';
    const ratings = process.env.EVAL_RATINGS
      ? (JSON.parse(readFileSync(process.env.EVAL_RATINGS, 'utf8')) as Record<string, boolean>)
      : undefined;
    const providers = createModelDeps(config);
    if (!providers) throw new Error('set GUARDRAIL_ID, GUARDRAIL_VERSION and ANTHROPIC_API_KEY');
    const { report, questions } = await evaluate({
      ...providers,
      documents: DOCUMENTS,
      jobs: JOBS,
      improve: PERSONAS,
      ratings,
    });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(out, 'questions.json'), `${JSON.stringify(questions, null, 2)}\n`);
    for (const gate of report.gates) {
      if (gate.status !== 'pass') process.stdout.write(`${JSON.stringify(gate)}\n`);
    }
    expect(report.gates.filter((gate) => gate.status === 'fail')).toEqual([]);
    expect(report.gates.filter((gate) => gate.status === 'pending')).toEqual([]);
  });
});
