import { analyzeResumeResultSchema } from '@talvio/llm-contracts';

import {
  CONFLICTING_SOURCE,
  JOB,
  SPARSE_SOURCE,
  TAILOR_SOURCE,
  analysisOutput,
  handle,
} from '../../test/fixtures/session';
import { careerView } from '../career/view';
import type { AnalysisOutput } from '../prompts/analyze-resume';
import type { AnswerInput } from '../prompts/session-input';
import { normalizeAnalysis, type AnalysisContext } from './normalize';

const SOURCE_HASH = 'a'.repeat(64);
const JD_HASH = 'b'.repeat(64);

const ctxFor = (source = TAILOR_SOURCE, extra: Partial<AnalysisContext> = {}): AnalysisContext => ({
  view: careerView(source.document),
  snapshot: source,
  sourceHash: SOURCE_HASH,
  jobDescription: { text: JOB.text, hash: JD_HASH },
  answers: [],
  sections: [],
  ...extra,
});

const finding = (
  patch: Partial<AnalysisOutput['findings'][number]>,
): AnalysisOutput['findings'][number] => ({
  severity: 'low',
  category: 'missing_information',
  section: null,
  entityId: null,
  message: 'Add a summary.',
  evidence: [],
  requirement: null,
  ...patch,
});

describe('normalizeAnalysis', () => {
  it('maps requirements to job description spans and coverage to the candidate’s own evidence', () => {
    const ctx = ctxFor();
    const { result, warnings, complete } = normalizeAnalysis(analysisOutput(ctx.view), ctx);
    analyzeResumeResultSchema.parse(result);
    expect(complete).toBe(true);
    expect(warnings).toEqual([]);
    expect(result.requirements.map((r) => [r.id, r.kind, r.text])).toEqual([
      ['req-1', 'required', '5+ years building backend services in Go'],
      ['req-2', 'required', 'experience with PostgreSQL at scale'],
      ['req-3', 'preferred', 'Kafka or another event streaming platform'],
      ['req-4', 'preferred', 'experience leading a small team'],
    ]);
    expect(result.requirements[0]?.evidence[0]).toMatchObject({
      sourceKind: 'job_description',
      sourceHash: JD_HASH,
      start: JOB.text.indexOf('5+ years'),
    });
    expect(result.coverage.map((c) => c.status)).toEqual([
      'partial',
      'partial',
      'supported',
      'supported',
    ]);
    // Coverage evidence is the candidate's, never the job description's.
    for (const entry of result.coverage) {
      expect(entry.evidence.every((ref) => ref.sourceKind === 'profile')).toBe(true);
    }
    expect(result.coverage[3]?.evidence[0]).toMatchObject({
      field: 'description',
      excerpt: 'Led the payments platform team',
    });
    // The job_match finding comes first and carries the requirement's span.
    expect(result.priorities).toEqual(['finding-2', 'finding-1']);
    expect(result.findings[1]?.evidence.map((ref) => ref.sourceKind)).toEqual([
      'profile',
      'job_description',
    ]);
  });

  it('downgrades claimed support it cannot find and drops requirements that are not in the job', () => {
    const ctx = ctxFor();
    const output = analysisOutput(ctx.view);
    output.requirements.push({ quote: '10 years of Rust', kind: 'required' });
    output.coverage[2] = {
      requirement: 2,
      status: 'supported',
      evidence: [{ ref: handle(ctx.view, 'legacy:tools:0', 'name'), quote: 'RabbitMQ' }],
      note: null,
    };
    // A requirement can never support itself.
    output.coverage[3] = {
      requirement: 3,
      status: 'supported',
      evidence: [{ ref: 'J1', quote: 'leading a small team' }],
      note: null,
    };
    const { result, warnings, complete } = normalizeAnalysis(output, ctx);
    analyzeResumeResultSchema.parse(result);
    expect(complete).toBe(false);
    expect(result.requirements).toHaveLength(4);
    expect(result.coverage[2]).toMatchObject({ status: 'missing', evidence: [] });
    expect(result.coverage[3]).toMatchObject({ status: 'missing', evidence: [] });
    expect(warnings.map((w) => w.code)).toEqual(['requirement_not_found', 'citation_not_found']);
  });

  it('drops findings that score the resume, lack evidence, have no requirement or are out of scope', () => {
    const ctx = ctxFor(TAILOR_SOURCE, { sections: ['experience'] });
    const output = analysisOutput(ctx.view);
    output.findings.push(
      finding({ message: 'Your ATS score is 62%.' }),
      finding({ category: 'job_match', message: 'Not a match.' }),
      finding({
        category: 'clarity',
        section: 'experience',
        message: 'Unclear.',
        evidence: [{ ref: 'F1', quote: 'not there' }],
      }),
      finding({ section: 'education', message: 'Add your thesis.' }),
      finding({ section: 'experience', message: 'Add a team size for Acme.' }),
    );
    const { result, warnings } = normalizeAnalysis(output, ctx);
    analyzeResumeResultSchema.parse(result);
    expect(result.findings.map((f) => f.message)).toEqual([
      'The Globex role lists a duty but no result.',
      'The job asks for 5+ years of Go; the profile does not say how long Go was used.',
      'Add a team size for Acme.',
    ]);
    expect(warnings.map((w) => w.code)).toEqual(['findings_dropped', 'citation_not_found']);
  });

  it('analyzes a sparse profile without a job description', () => {
    const ctx = ctxFor(SPARSE_SOURCE, { jobDescription: null });
    const output: AnalysisOutput = {
      requirements: [{ quote: 'Go', kind: 'required' }],
      coverage: [],
      findings: [
        finding({
          severity: 'high',
          section: 'experience',
          entityId: 'exp-sparse-1',
          message: 'The Northwind role has no dates or results.',
        }),
        finding({ section: 'skills', message: 'No skills are listed.' }),
      ],
    };
    const { result, complete } = normalizeAnalysis(output, ctx);
    analyzeResumeResultSchema.parse(result);
    expect(complete).toBe(true);
    expect(result.requirements).toEqual([]);
    expect(result.coverage).toEqual([]);
    expect(result.findings.map((f) => [f.section, f.entityId])).toEqual([
      ['experience', 'exp-sparse-1'],
      ['skills', null],
    ]);
  });

  it('keeps a conflict with both sides cited', () => {
    const ctx = ctxFor(CONFLICTING_SOURCE, { jobDescription: null });
    const output: AnalysisOutput = {
      requirements: [],
      coverage: [],
      findings: [
        finding({
          severity: 'high',
          category: 'consistency',
          section: 'experience',
          message: 'Two full-time roles overlap from 2020 to 2022.',
          evidence: [
            { ref: handle(ctx.view, 'exp-conflict-1', 'startDate'), quote: null },
            { ref: handle(ctx.view, 'exp-conflict-2', 'endDate'), quote: null },
          ],
        }),
      ],
    };
    const { result } = normalizeAnalysis(output, ctx);
    expect(result.findings[0]?.evidence.map((ref) => [ref.entityId, ref.excerpt])).toEqual([
      ['exp-conflict-1', '2020-01'],
      ['exp-conflict-2', '2022-01'],
    ]);
  });

  it('accepts the candidate’s answers as evidence, tied to the question and answer revision', () => {
    const answers: AnswerInput[] = [
      {
        handle: 'A1',
        questionId: 'r1-q1',
        answerRevisionId: '0b9d5c3e-1f2a-4b3c-8d4e-5f6a7b8c9d0e',
        topicKey: 'skills.go-years',
        question: 'How long have you used Go?',
        value: 'I have built Go services for six years.',
      },
    ];
    const ctx = ctxFor(TAILOR_SOURCE, { answers });
    const output = analysisOutput(ctx.view);
    output.coverage[0] = {
      requirement: 0,
      status: 'supported',
      evidence: [{ ref: 'A1', quote: 'Go services for six years' }],
      note: null,
    };
    const { result } = normalizeAnalysis(output, ctx);
    analyzeResumeResultSchema.parse(result);
    expect(result.coverage[0]).toMatchObject({
      status: 'supported',
      evidence: [
        {
          sourceKind: 'answer',
          questionId: 'r1-q1',
          answerRevisionId: answers[0]!.answerRevisionId,
          excerpt: 'Go services for six years',
        },
      ],
    });
  });
});
