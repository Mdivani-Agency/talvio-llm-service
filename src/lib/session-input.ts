import type { CreateJobRequest } from '@talvio/llm-contracts';

import { careerView } from './career/view';
import type { AnswerInput, SessionInput } from './prompts/session-input';
import type { SessionContext } from './store';

/*
 * What a session operation reads from its context revision (design §§5, 12): the source as a
 * field listing, the job description and the answers that still apply. An answer applies when its
 * question set was issued for this revision's source and job description; a later answer to the
 * same question replaces an earlier one, and a skip removes it.
 */

export type SessionRequest = Exclude<CreateJobRequest, { operation: 'parse_document' }>;

export type PreparedSession = {
  input: SessionInput;
  /** Topics already asked in the session, with what became of them. */
  askedTopics: { topicKey: string; status: 'answered' | 'skipped' | 'unanswered' }[];
};

export function prepareSession(ctx: SessionContext): PreparedSession {
  const { revision } = ctx;
  const current = new Map(
    ctx.questionSets
      .filter(
        (set) =>
          set.sourceHash === revision.sourceHash &&
          set.jobDescriptionHash === revision.jobDescriptionHash,
      )
      .flatMap((set) => set.questions.map((question) => [question.id, question] as const)),
  );

  // Latest status per question id, across every submission up to this revision.
  const latest = new Map<
    string,
    { status: 'answered' | 'skipped'; value: string | null; revision: string }
  >();
  for (const submission of ctx.answers) {
    for (const answer of submission.answers) {
      latest.set(answer.questionId, {
        status: answer.status,
        value: answer.status === 'answered' ? answer.value : null,
        revision: submission.answerRevisionId,
      });
    }
  }

  const answers: AnswerInput[] = [];
  for (const [questionId, entry] of latest) {
    const question = current.get(questionId);
    if (!question || entry.status !== 'answered' || !entry.value) continue;
    answers.push({
      handle: `A${answers.length + 1}`,
      questionId,
      answerRevisionId: entry.revision,
      topicKey: question.topicKey,
      question: question.prompt,
      value: entry.value,
    });
  }

  // Every topic issued in the session counts as asked, whatever the source revision.
  const askedTopics = ctx.questionSets.flatMap((set) =>
    set.questions.map((question) => ({
      topicKey: question.topicKey,
      status: latest.get(question.id)?.status ?? ('unanswered' as const),
    })),
  );

  return {
    input: {
      view: careerView(ctx.source.document),
      jobDescription: ctx.jobDescription?.text ?? null,
      answers,
    },
    askedTopics,
  };
}
