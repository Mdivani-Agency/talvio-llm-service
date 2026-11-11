import { parseDocumentResultSchema } from '@talvio/llm-contracts';

import { modelOutput, RESUME } from '../../test/fixtures/parse';
import { sha256Hex } from '../blob';
import { normalizeParse, type SourceMeta } from './normalize';

const META: SourceMeta = {
  sourceHash: sha256Hex(Buffer.from(RESUME)),
  clientSupplied: true,
  pages: [{ page: 1, start: 0, end: RESUME.length }],
};

const run = (output = modelOutput(), text = RESUME, meta = META) =>
  normalizeParse(output, text, meta);
const valid = (out: ReturnType<typeof run>) =>
  parseDocumentResultSchema.parse({
    career: out.career,
    facts: out.facts,
    uncertainties: out.uncertainties,
    extraction: {
      method: 'plain_text',
      ocrPages: 0,
      complete: out.complete,
      pagesNeedingReview: [],
    },
  });

describe('normalizeParse', () => {
  it('keeps quoted values with their source offsets and reads dates deterministically', () => {
    const out = run();
    valid(out);
    expect(out.complete).toBe(true);
    expect(out.uncertainties).toEqual([]);
    const [acme, globex] = out.career.experience;
    expect(acme).toMatchObject({
      id: 'parsed:experience:0',
      company: 'Acme Payments',
      employmentType: 'full-time',
      locationType: 'remote',
      startDate: '2021-03',
      endDate: null,
      current: true,
      achievements: ['Cut settlement latency by 40% by redesigning the ledger service'],
      responsibilities: ['Own the on-call rotation for the payments API'],
    });
    expect(globex).toMatchObject({ startDate: '2018', endDate: '2021', current: false });
    expect(out.career.education[0]).toMatchObject({
      degreeType: "Bachelor's Degree",
      startDate: '2014',
    });
    expect(out.career.languages.map((l) => l.proficiency)).toEqual(['native', 'fluent']);
    expect(out.career.person.seniority).toBeNull();

    const employer = out.facts.find((fact) => fact.predicate === 'employer');
    const ref = employer!.evidence[0]!;
    expect(RESUME.slice(ref.start, ref.end)).toBe('Acme Payments');
    expect(ref).toMatchObject({ sourceHash: META.sourceHash, clientSupplied: true, page: 1 });
    const start = out.facts.find((fact) => fact.predicate === 'start_date');
    expect(start).toMatchObject({ date: '2021-03', datePrecision: 'month' });
  });

  it('leaves invented values empty and reports them, so the result is partial', () => {
    const output = modelOutput();
    output.experience[0]!.company = 'Initech';
    output.skills.push('Kubernetes');
    const out = run(output);
    valid(out);
    expect(out.career.experience[0]!.company).toBeNull();
    expect(out.career.skills.map((s) => s.name)).toEqual(['TypeScript', 'PostgreSQL', 'AWS']);
    expect(out.uncertainties).toEqual([
      expect.objectContaining({
        section: 'experience',
        entityId: 'parsed:experience:0',
        field: 'company',
        reason: 'ambiguous',
      }),
      expect.objectContaining({ section: 'skills', reason: 'ambiguous' }),
    ]);
    expect(out.complete).toBe(false);
  });

  it('never guesses a date or a current role', () => {
    const text = `${RESUME}\nInitech — Analyst\n03/04/2016`;
    const output = modelOutput();
    output.experience.push({
      company: 'Initech',
      jobTitle: 'Analyst',
      employmentType: null,
      locationType: null,
      start: '03/04/2016',
      end: null,
      summary: null,
      bullets: [],
    });
    const out = run(output, text, { ...META, sourceHash: sha256Hex(Buffer.from(text)) });
    valid(out);
    // The incomplete entry is kept, with what it has.
    expect(out.career.experience[2]).toMatchObject({
      company: 'Initech',
      startDate: null,
      endDate: null,
      current: null,
    });
    expect(out.uncertainties).toEqual([
      expect.objectContaining({
        entityId: 'parsed:experience:2',
        field: 'startDate',
        reason: 'unknown_date',
      }),
    ]);
  });

  it('drops classifications the text does not state', () => {
    const output = modelOutput();
    output.experience[1]!.employmentType = 'contract';
    output.languages[1]!.proficiency = 'native';
    const out = run(output);
    expect(out.career.experience[1]!.employmentType).toBeNull();
    expect(out.career.languages[1]!.proficiency).toBeNull();
  });

  it('reports resume text that no field holds', () => {
    const output = modelOutput();
    output.experience[1]!.bullets = [];
    const out = run(output);
    expect(out.warnings).toEqual([
      expect.objectContaining({ code: 'text_not_accounted', page: 1 }),
    ]);
    expect(out.complete).toBe(false);

    const placed = run({ ...output, unplaced: ['Built the billing export used by 300 customers'] });
    expect(placed.warnings.map((w) => w.code)).toEqual(['unplaced_text']);
  });

  it('reports what does not fit a section instead of cutting it quietly', () => {
    const output = modelOutput({ skills: Array.from({ length: 60 }, () => 'TypeScript') });
    const many = `${RESUME}\n${Array.from({ length: 60 }, (_, i) => `Skill${i}`).join(', ')}`;
    output.skills = Array.from({ length: 60 }, (_, i) => `Skill${i}`);
    const out = run(output, many, { ...META, pages: [] });
    valid(out);
    expect(out.career.skills).toHaveLength(50);
    expect(out.warnings).toContainEqual(expect.objectContaining({ code: 'section_limit' }));
    expect(out.complete).toBe(false);
  });
});
