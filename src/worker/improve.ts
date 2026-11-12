import { randomUUID } from 'crypto';

import { applyTargetFor, ApplyTargetError } from '@talvio/llm-contracts';

import { normalizeImprovement, type ImproveOperation } from '../lib/improve/normalize';
import { IMPROVE_PACK, improveGuardText, improveMessage } from '../lib/prompts/improve';
import { untrustedText } from '../lib/prompts/session-input';
import { prepareSession } from '../lib/session-input';
import type { SessionDeps } from './analyze';
import { paidJob, stopping } from './paid';
import type { Executor } from './run';
import { loadSessionJob, publishSession } from './session-job';

/*
 * improve_profile / improve_resume (design §§5, 9, 12): the context revision's source and the
 * answers that still apply (skipped questions never count) are improved in one bounded call; the
 * result is a proposal the user reviews. Nothing here writes a profile or resume.
 */

export function createImproveExecutor(deps: SessionDeps, operation: ImproveOperation): Executor {
  return (context) =>
    stopping(async () => {
      const { job } = context;
      const paid = paidJob(deps, context);
      const loaded = await loadSessionJob(deps.store, job, operation, paid);
      const { source, revision } = loaded.context;
      try {
        applyTargetFor(operation, source.source);
      } catch (error) {
        // Admission refuses this; a request stored before that check cannot be improved.
        if (error instanceof ApplyTargetError) return paid.stop('revoked');
        throw error;
      }
      const { input } = prepareSession(loaded.context, { descriptionLines: true });
      const { sections, targetRole } = loaded.request.input;
      const user = improveMessage({ ...input, sections, targetRole });

      await paid.guard(improveGuardText(untrustedText(input), targetRole), (available) =>
        paid.planFor(IMPROVE_PACK, user, available),
      );
      const output = await paid.infer(IMPROVE_PACK, user);
      const normalized = normalizeImprovement(output, {
        operation,
        proposalId: randomUUID(),
        snapshot: source,
        sourceHash: revision.sourceHash,
        view: input.view,
        answers: input.answers,
        sections,
      });
      return publishSession(deps, job, operation, loaded, IMPROVE_PACK, normalized, paid.spent());
    });
}
