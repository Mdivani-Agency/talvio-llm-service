import { randomUUID } from 'crypto';

import { prepareSession } from '../lib/session-input';
import { untrustedText } from '../lib/prompts/session-input';
import {
  REQUIREMENTS_PACK,
  requirementsMessage,
  TAILOR_PACK,
  tailorMessage,
  worstTailorMessage,
} from '../lib/prompts/tailor';
import { composeTailoring, groundRequirements } from '../lib/tailor/compose';
import type { SessionDeps } from './analyze';
import { paidJob, stopping } from './paid';
import type { Executor } from './run';
import { loadSessionJob, publishSession } from './session-job';

/*
 * tailor_resume (design §§3, 5, 9, 12; MDI-220): the session's source, job description and the
 * answers that still apply (none is required) are checked by the input guardrail once, then two
 * bounded calls run under the job's one budget. The result is a proposal for a new
 * job-specific resume; nothing here writes a profile, a resume, a PDF or a credit.
 */

export function createTailorExecutor(deps: SessionDeps): Executor {
  return (context) =>
    stopping(async () => {
      const { job } = context;
      const paid = paidJob(deps, context);
      const loaded = await loadSessionJob(deps.store, job, 'tailor_resume', paid);
      const { source, revision, jobDescription } = loaded.context;
      if (!jobDescription || !revision.jobDescriptionHash) return paid.stop('revoked');
      const { input } = prepareSession(loaded.context, { descriptionLines: true });

      // Both calls must fit after the guardrail: plan the first, then the worst second.
      const first = requirementsMessage(jobDescription.text);
      const second = worstTailorMessage(input);
      await paid.guard(untrustedText(input), (available) => {
        const plan = paid.planFor(REQUIREMENTS_PACK, first, available);
        return plan && paid.planFor(TAILOR_PACK, second, available - plan.boundMicroUsd);
      });

      // Checkpoints are content-free, so the requirements are not kept: a retry reads them again,
      // within the same budget.
      const extracted = await paid.infer(REQUIREMENTS_PACK, first, 'extraction');
      const { requirements } = groundRequirements(extracted, jobDescription.text);

      const output = await paid.infer(TAILOR_PACK, tailorMessage(input, requirements));
      const composed = composeTailoring(requirements, output, {
        proposalId: randomUUID(),
        snapshot: source,
        sourceHash: revision.sourceHash,
        view: input.view,
        answers: input.answers,
        jobDescription: { text: jobDescription.text, hash: revision.jobDescriptionHash },
      });
      return publishSession(
        deps,
        job,
        'tailor_resume',
        loaded,
        TAILOR_PACK,
        composed,
        paid.spent(),
      );
    });
}
