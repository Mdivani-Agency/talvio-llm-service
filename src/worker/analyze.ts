import { normalizeAnalysis } from '../lib/analysis/normalize';
import type { Logger } from '../lib/log';
import type { Guardrail, ModelClient } from '../lib/model/client';
import { ANALYZE_PACK, analysisMessage } from '../lib/prompts/analyze-resume';
import { untrustedText } from '../lib/prompts/session-input';
import type { Store } from '../lib/store';
import { paidJob, stopping } from './paid';
import type { Executor } from './run';
import { loadSessionJob, publishSession } from './session-job';

/*
 * analyze_resume (design §§5, 9): the context revision's source, job description and answers are
 * checked by the input guardrail, analyzed in one bounded call and grounded before publishing.
 */

export type SessionDeps = {
  store: Store;
  model: ModelClient;
  guardrail: Guardrail;
  logger: Logger;
};

export function createAnalyzeExecutor(deps: SessionDeps): Executor {
  return (context) =>
    stopping(async () => {
      const { job } = context;
      const paid = paidJob(deps, context);
      const loaded = await loadSessionJob(deps.store, job, 'analyze_resume', paid);
      const { input } = loaded.prepared;
      const sections = loaded.request.input.sections;
      const user = analysisMessage(input, sections);

      await paid.guard(untrustedText(input), (available) =>
        paid.planFor(ANALYZE_PACK, user, available),
      );
      const output = await paid.infer(ANALYZE_PACK, user);
      const { revision, source, jobDescription } = loaded.context;
      const normalized = normalizeAnalysis(output, {
        view: input.view,
        snapshot: source,
        sourceHash: revision.sourceHash,
        jobDescription:
          jobDescription && revision.jobDescriptionHash
            ? { text: jobDescription.text, hash: revision.jobDescriptionHash }
            : null,
        answers: input.answers,
        sections,
      });
      return publishSession(
        deps,
        job,
        'analyze_resume',
        loaded,
        ANALYZE_PACK,
        normalized,
        paid.spent(),
      );
    });
}
