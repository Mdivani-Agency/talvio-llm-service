import { randomUUID } from 'crypto';

import {
  analyzeResumeResultSchema,
  type OperationResult,
  type Question,
  type Warning,
} from '@talvio/llm-contracts';

import { questionsMessage, QUESTIONS_PACK } from '../lib/prompts/generate-questions';
import { untrustedText } from '../lib/prompts/session-input';
import { normalizeQuestions } from '../lib/questions/normalize';
import type { JobRecord } from '../lib/store';
import type { SessionDeps } from './analyze';
import { paidJob, stopping } from './paid';
import type { Executor } from './run';
import { loadSessionJob, publishSession, type Loaded } from './session-job';

/*
 * generate_questions (design §§3, 12). The job took its round and question slots at admission; it
 * publishes by issuing the set, which commits the round only if this job still holds it. The set
 * id is checkpointed before issuing, so a repeat after a lost response publishes the set already
 * issued instead of asking the model again.
 */

type Analysis = OperationResult<'analyze_resume'>;

/** A compatible earlier analysis: same session, same source and job description, succeeded. */
async function compatibleAnalysis(
  deps: SessionDeps,
  job: JobRecord,
  loaded: Loaded<'generate_questions'>,
): Promise<{ analysis: Analysis | null; warnings: Warning[] }> {
  const id = loaded.request.input.analysisJobId;
  if (!id) return { analysis: null, warnings: [] };
  const unused = {
    analysis: null,
    warnings: [
      {
        code: 'analysis_not_used',
        message: 'The analysis was not used: it is not finished or was made for other content.',
        entityId: null,
        page: null,
      },
    ],
  };
  const analysisJob = await deps.store.jobs.get(job.ownerId, id);
  if (
    !analysisJob ||
    analysisJob.operation !== 'analyze_resume' ||
    analysisJob.status !== 'succeeded' ||
    analysisJob.sessionId !== loaded.request.sessionId ||
    !analysisJob.contextRevisionId
  ) {
    return unused;
  }
  const then = await deps.store.sessions.context(
    job.ownerId,
    loaded.request.sessionId,
    analysisJob.contextRevisionId,
  );
  const now = loaded.context.revision;
  if (
    !then ||
    then.revision.sourceHash !== now.sourceHash ||
    then.revision.jobDescriptionHash !== now.jobDescriptionHash
  ) {
    return unused;
  }
  const parsed = analyzeResumeResultSchema.safeParse(
    (analysisJob.result as { result?: unknown } | null)?.result,
  );
  return parsed.success ? { analysis: parsed.data, warnings: [] } : unused;
}

export function createQuestionsExecutor(deps: SessionDeps): Executor {
  return (context) =>
    stopping(async () => {
      const { job } = context;
      const paid = paidJob(deps, context);
      const loaded = await loadSessionJob(deps.store, job, 'generate_questions', paid);
      const { round } = loaded.request.input;
      const { sessionId } = loaded.request;
      const session = await deps.store.sessions.get(job.ownerId, sessionId);
      const holder = session?.rounds[round];
      if (!session || holder?.jobId !== job.jobId) return paid.stop('revoked');

      const publish = (questions: Question[], questionSetId: string, warnings: Warning[]) =>
        publishSession(
          deps,
          job,
          'generate_questions',
          loaded,
          QUESTIONS_PACK,
          { complete: true, warnings, result: { questionSetId, round, questions } },
          paid.spent(),
        );

      // Already issued by an earlier attempt of this job: publish that set.
      const known = paid.ledger.publishing?.questionSetId;
      if (known) {
        const issued = await deps.store.sessions.getQuestionSet(job.ownerId, sessionId, known);
        if (issued?.jobId === job.jobId) return publish(issued.questions, known, []);
      }

      const { input } = loaded.prepared;
      const { analysis, warnings } = await compatibleAnalysis(deps, job, loaded);
      const slots = Math.min(loaded.request.input.maxQuestions, holder.slots);
      let questions: Question[] = [];
      if (slots > 0) {
        const user = questionsMessage({
          ...input,
          maxQuestions: slots,
          analysis,
          askedTopics: loaded.prepared.askedTopics,
        });
        await paid.guard(untrustedText(input), (available) =>
          paid.planFor(QUESTIONS_PACK, user, available),
        );
        const output = await paid.infer(QUESTIONS_PACK, user);
        const normalized = normalizeQuestions(output, {
          round,
          slots,
          view: input.view,
          knownText: [input.view.allText, input.jobDescription ?? ''].join('\n'),
          askedTopics: new Set(loaded.prepared.askedTopics.map((t) => t.topicKey)),
          analysis,
        });
        questions = normalized.questions;
        warnings.push(...normalized.warnings);
      }

      const questionSetId = known ?? randomUUID();
      await paid.write('publishing', { ...(paid.ledger.publishing ?? {}), questionSetId });
      const issued = await deps.store.sessions.issueQuestionSet(
        job.ownerId,
        {
          questionSetId,
          sessionId,
          round,
          questions,
          sourceHash: loaded.context.revision.sourceHash,
          jobDescriptionHash: loaded.context.revision.jobDescriptionHash,
          jobId: job.jobId,
        },
        context.now(),
      );
      if (issued !== 'issued') return paid.stop('revoked');
      return publish(questions, questionSetId, warnings);
    });
}
