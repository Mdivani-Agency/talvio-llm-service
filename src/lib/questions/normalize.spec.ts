import { questionSchema } from '@talvio/llm-contracts';

import {
  CONFLICTING_SOURCE,
  JOB,
  TAILOR_SOURCE,
  analysisOutput,
} from '../../test/fixtures/session';
import { normalizeAnalysis } from '../analysis/normalize';
import { careerView } from '../career/view';
import type { QuestionsOutput } from '../prompts/generate-questions';
import { normalizeQuestions, topicKeyOf, type QuestionsContext } from './normalize';

type Raw = QuestionsOutput['questions'][number];

const raw = (patch: Partial<Raw>): Raw => ({
  topicKey: 'experience.team-size',
  prompt: 'How many people were on the payments platform team you led?',
  guidance: 'Say who reported to you and who you worked with.',
  reason: 'The job asks for team leadership.',
  targetSection: 'experience',
  targetEntityId: null,
  findingId: null,
  requirementIds: [],
  ...patch,
});

const view = careerView(TAILOR_SOURCE.document);
const analysis = normalizeAnalysis(analysisOutput(view), {
  view,
  snapshot: TAILOR_SOURCE,
  sourceHash: 'a'.repeat(64),
  jobDescription: { text: JOB.text, hash: 'b'.repeat(64) },
  answers: [],
  sections: [],
}).result;

const ctx = (patch: Partial<QuestionsContext> = {}): QuestionsContext => ({
  round: 1,
  slots: 5,
  view,
  knownText: `${view.allText}\n${JOB.text}`,
  askedTopics: new Set(),
  analysis,
  ...patch,
});

describe('normalizeQuestions', () => {
  it('issues ids and keeps questions that point at a real gap', () => {
    const { questions, warnings } = normalizeQuestions(
      {
        questions: [
          raw({ requirementIds: ['req-4', 'req-99'], findingId: 'finding-2' }),
          raw({
            topicKey: 'Skills / Go Years',
            prompt: 'How many years have you built services in Go?',
            targetSection: null,
            targetEntityId: '4a5b6c7d-8e9f-4a0b-9c2d-3e4f5a6b7c84',
          }),
        ],
      },
      ctx(),
    );
    expect(warnings).toEqual([]);
    expect(questions.map((q) => questionSchema.parse(q))).toEqual([
      expect.objectContaining({ id: 'r1-q1', requirementIds: ['req-4'] }),
      expect.objectContaining({
        id: 'r1-q2',
        topicKey: 'skills-go-years',
        targetSection: 'skills',
        targetEntityId: '4a5b6c7d-8e9f-4a0b-9c2d-3e4f5a6b7c84',
      }),
    ]);
  });

  it('accepts zero questions', () => {
    expect(normalizeQuestions({ questions: [] }, ctx())).toEqual({ questions: [], warnings: [] });
  });

  it('never re-asks a topic from the session or repeats one in the set', () => {
    const { questions, warnings } = normalizeQuestions(
      {
        questions: [
          raw({}),
          raw({ topicKey: 'experience.team-size' }),
          raw({ topicKey: 'experience.on-call' }),
        ],
      },
      ctx({ askedTopics: new Set(['experience.on-call']) }),
    );
    expect(questions.map((q) => q.topicKey)).toEqual(['experience.team-size']);
    expect(warnings.map((w) => w.code)).toEqual(['questions_dropped']);
  });

  it('drops a question that states a number the profile does not contain, and number-bearing guidance', () => {
    const conflicted = careerView(CONFLICTING_SOURCE.document);
    const { questions } = normalizeQuestions(
      {
        questions: [
          raw({ topicKey: 'a', prompt: 'Did you grow revenue by 30%?' }),
          raw({ topicKey: 'b', prompt: 'Was the team of 12 engineers at Contoso yours alone?' }),
          raw({ topicKey: 'c', guidance: 'For example, 5 engineers and 2 designers.' }),
        ],
      },
      ctx({ view: conflicted, knownText: conflicted.allText, analysis: null }),
    );
    expect(questions.map((q) => [q.topicKey, q.guidance])).toEqual([
      ['b', 'Say who reported to you and who you worked with.'],
      ['c', null],
    ]);
  });

  it('drops a question that points at nothing, and stops at the slots left', () => {
    const { questions } = normalizeQuestions(
      {
        questions: [
          raw({ topicKey: 'a', targetSection: null, requirementIds: ['req-unknown'] }),
          raw({ topicKey: 'b' }),
          raw({ topicKey: 'c' }),
          raw({ topicKey: 'd' }),
        ],
      },
      ctx({ round: 2, slots: 2 }),
    );
    expect(questions.map((q) => q.id)).toEqual(['r2-q1', 'r2-q2']);
    expect(questions.map((q) => q.topicKey)).toEqual(['b', 'c']);
  });
});

describe('topicKeyOf', () => {
  it('makes a valid key or none', () => {
    expect(topicKeyOf('  Experience.Team Size ')).toBe('experience.team-size');
    expect(topicKeyOf('---')).toBeNull();
    expect(topicKeyOf('a'.repeat(80))).toHaveLength(64);
  });
});
