import { evaluateGates } from './gates';
import { InvalidRatingsError, rateRun } from './rate';
import type { QuestionSample, Report } from './run';
import { emptyCounts } from './score';

const base: Omit<Report, 'gates'> = {
  set: { documents: 60, jobDescriptions: 20, bySourceType: {}, byTrait: {} },
  extraction: { all: emptyCounts(), bySourceType: {}, byTrait: {}, blockedInjections: [] },
  injectionHits: 0,
  proposals: { checked: 10, lost: 0, fabrications: 0, findings: [] },
  schema: { succeeded: 5, valid: 5 },
  operations: {},
  questions: { asked: 3, rated: 0, useful: 0 },
  jobs: [],
};
const unrated: Report = { ...base, gates: evaluateGates(base) };

const question = (key: string): QuestionSample => ({
  key,
  fixtureId: 'j1',
  prompt: 'p',
  reason: 'r',
});
const questions = ['a', 'b', 'c'].map(question);
const usefulness = (report: Report) => report.gates.find((g) => g.gate === 'questions.useful');

describe('rating a finished run', () => {
  it('starts pending', () => {
    expect(usefulness(unrated)?.status).toBe('pending');
  });

  it('passes once every question is rated useful enough', () => {
    const rated = rateRun(unrated, questions, { a: true, b: true, c: true });
    expect(rated.report.questions).toEqual({ asked: 3, rated: 3, useful: 3 });
    expect(usefulness(rated.report)).toMatchObject({ status: 'pass', value: 1 });
    expect(rated.unrated).toEqual([]);
    // Every other gate is recomputed unchanged.
    expect(rated.report.gates.filter((g) => g.gate !== 'questions.useful')).toEqual(
      unrated.gates.filter((g) => g.gate !== 'questions.useful'),
    );
  });

  it('fails below the threshold and stays pending while any question is unrated', () => {
    expect(
      usefulness(rateRun(unrated, questions, { a: true, b: false, c: true }).report)?.status,
    ).toBe('fail');
    const partial = rateRun(unrated, questions, { a: true, b: true, z: true });
    expect(usefulness(partial.report)?.status).toBe('pending');
    expect(partial.unrated).toEqual(['c']);
    expect(partial.unknown).toEqual(['z']);
  });

  it('rejects a rating that is not true or false', () => {
    expect(() => rateRun(unrated, questions, { a: true, b: 'yes', c: null })).toThrow(
      InvalidRatingsError,
    );
  });
});
