import { evaluateGates } from './gates';
import type { QuestionSample, Report } from './run';

/*
 * Scores people's usefulness ratings against a finished live run (design §14), so the questions a
 * run generated can be rated without generating new ones. A new run asks different questions,
 * and a rating is keyed by its question's text, so ratings only ever apply to the run they were
 * made for.
 */

export type Ratings = Record<string, boolean>;

export class InvalidRatingsError extends Error {
  constructor(readonly keys: string[]) {
    super('ratings must be true or false');
    this.name = 'InvalidRatingsError';
  }
}

export function rateRun(
  report: Report,
  questions: QuestionSample[],
  ratings: Record<string, unknown>,
): { report: Report; unrated: string[]; unknown: string[] } {
  const invalid = Object.keys(ratings).filter((key) => typeof ratings[key] !== 'boolean');
  if (invalid.length > 0) throw new InvalidRatingsError(invalid);
  const valid = ratings as Ratings;
  const keys = new Set(questions.map((q) => q.key));
  const rated = questions.filter((q) => q.key in valid);
  const { gates: _old, ...rest } = report;
  const next: Omit<Report, 'gates'> = {
    ...rest,
    questions: {
      asked: questions.length,
      rated: rated.length,
      useful: rated.filter((q) => valid[q.key]).length,
    },
  };
  return {
    report: { ...next, gates: evaluateGates(next) },
    unrated: questions.filter((q) => !(q.key in valid)).map((q) => q.key),
    unknown: Object.keys(valid).filter((key) => !keys.has(key)),
  };
}
