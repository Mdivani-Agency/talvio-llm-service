import type { Question } from '@talvio/llm-contracts';

import { JOB, TAILOR_SOURCE } from '../test/fixtures/session';
import { prepareSession } from './session-input';
import type { QuestionSetRecord, SessionContext } from './store';

const SOURCE = 'a'.repeat(64);
const question = (id: string, topicKey: string): Question => ({
  id,
  topicKey,
  prompt: `About ${topicKey}?`,
  guidance: null,
  reason: 'r',
  targetSection: null,
  targetEntityId: null,
  requirementIds: [],
});
const set = (
  id: string,
  round: number,
  questions: Question[],
  sourceHash = SOURCE,
): QuestionSetRecord => ({
  questionSetId: id,
  sessionId: 's',
  round,
  questions,
  sourceHash,
  jobDescriptionHash: null,
  jobId: null,
});

const context = (patch: Partial<SessionContext>): SessionContext => ({
  revision: {
    contextRevisionId: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    contextHash: 'c'.repeat(64),
    sourceHash: SOURCE,
    jobDescriptionHash: null,
    answerRevisionId: null,
    createdAt: '2026-11-11T12:00:00.000Z',
  },
  source: TAILOR_SOURCE,
  jobDescription: null,
  questionSets: [],
  answers: [],
  ...patch,
});

describe('prepareSession', () => {
  it('uses the latest answer per question, drops skips and answers for another source', () => {
    const prepared = prepareSession(
      context({
        jobDescription: JOB,
        questionSets: [
          set('set-old', 1, [question('r1-q1', 'old-topic')], 'f'.repeat(64)),
          set('set-1', 1, [question('r1-q2', 'team-size'), question('r1-q3', 'on-call')]),
        ],
        answers: [
          {
            answerRevisionId: 'rev-1',
            questionSetId: 'set-1',
            createdAt: new Date('2026-11-11T10:00:00Z'),
            answers: [
              { questionId: 'r1-q2', status: 'answered', value: 'Four people.' },
              { questionId: 'r1-q3', status: 'answered', value: 'Yes, weekly.' },
            ],
          },
          {
            answerRevisionId: 'rev-2',
            questionSetId: 'set-1',
            createdAt: new Date('2026-11-11T11:00:00Z'),
            answers: [
              { questionId: 'r1-q2', status: 'answered', value: 'Five people.' },
              { questionId: 'r1-q3', status: 'skipped' },
            ],
          },
          {
            answerRevisionId: 'rev-3',
            questionSetId: 'set-old',
            createdAt: new Date('2026-11-11T11:30:00Z'),
            answers: [{ questionId: 'r1-q1', status: 'answered', value: 'Stale.' }],
          },
        ],
      }),
    );
    expect(prepared.input.jobDescription).toBe(JOB.text);
    expect(prepared.input.answers).toEqual([
      {
        handle: 'A1',
        questionId: 'r1-q2',
        answerRevisionId: 'rev-2',
        topicKey: 'team-size',
        question: 'About team-size?',
        value: 'Five people.',
      },
    ]);
    // Every topic issued in the session counts as asked, with what became of it.
    expect(prepared.askedTopics).toEqual([
      { topicKey: 'old-topic', status: 'answered' },
      { topicKey: 'team-size', status: 'answered' },
      { topicKey: 'on-call', status: 'skipped' },
    ]);
  });
});
