import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { rateRun } from './rate';
import type { QuestionSample, Report } from './run';

/*
 * Applies usefulness ratings to the last `yarn eval:live` run, with no model calls. Skipped unless
 * LLM_EVAL_RATE=1:
 *
 *   EVAL_RATINGS=ratings.json yarn eval:rate
 *
 * It reads report.json and questions.json from EVAL_OUT (default eval-out/), writes the rated
 * report back, and fails while any gate fails or any question is unrated. Without EVAL_RATINGS it
 * writes ratings.template.json, one key per question, for people to fill in with true or false.
 */

const enabled = process.env.LLM_EVAL_RATE === '1';
const suite = enabled ? describe : describe.skip;

const read = <T>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T;

suite('release evaluation ratings', () => {
  it('clears every gate once the questions are rated', () => {
    const out = process.env.EVAL_OUT ?? 'eval-out';
    const questions = read<QuestionSample[]>(join(out, 'questions.json'));
    if (!process.env.EVAL_RATINGS) {
      const template = Object.fromEntries(questions.map((q) => [q.key, null]));
      writeFileSync(join(out, 'ratings.template.json'), `${JSON.stringify(template, null, 2)}\n`);
      throw new Error(`set EVAL_RATINGS; wrote ${join(out, 'ratings.template.json')}`);
    }
    const { report, unrated, unknown } = rateRun(
      read<Report>(join(out, 'report.json')),
      questions,
      read<Record<string, unknown>>(process.env.EVAL_RATINGS),
    );
    writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (unknown.length > 0) process.stdout.write(`not from this run: ${unknown.join(', ')}\n`);
    if (unrated.length > 0) process.stdout.write(`unrated: ${unrated.join(', ')}\n`);
    for (const gate of report.gates) {
      if (gate.status !== 'pass') process.stdout.write(`${JSON.stringify(gate)}\n`);
    }
    expect(report.gates.filter((gate) => gate.status !== 'pass')).toEqual([]);
  });
});
