import { tailorResumeResultSchema } from '@talvio/llm-contracts';

import { JOB, TAILOR_SOURCE, handle } from '../../test/fixtures/session';
import { careerView } from '../career/view';
import type { TailorOutput } from '../prompts/tailor';
import { composeTailoring, groundRequirements, type TailorContext } from './compose';

const ACME = '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f51';
const GLOBEX = '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a62';
const EDUCATION = '3f4a5b6c-7d8e-4f9a-8b1c-2d3e4f5a6b73';
const PROPOSAL = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const source = structuredClone(TAILOR_SOURCE);
source.document.experience[0]!.responsibilities = ['Own the payments API on Kubernetes'];
const view = careerView(source.document, { descriptionLines: true });

const requirements = groundRequirements(
  {
    requirements: [
      { quote: '5+ years building backend services in Go', kind: 'required' },
      { quote: 'experience with PostgreSQL at scale', kind: 'required' },
      { quote: 'Kafka or another event streaming platform', kind: 'preferred' },
      { quote: 'experience leading a small team', kind: 'preferred' },
      { quote: 'Rust experience', kind: 'required' },
      { quote: '5+ years building backend services in Go', kind: 'required' },
    ],
  },
  JOB.text,
).requirements;

const ctx: TailorContext = {
  proposalId: PROPOSAL,
  snapshot: source,
  sourceHash: 'a'.repeat(64),
  view,
  answers: [],
  jobDescription: { text: JOB.text, hash: 'b'.repeat(64) },
};

const output = (patch: Partial<TailorOutput> = {}): TailorOutput => ({
  coverage: [],
  changes: [],
  additions: [],
  omissions: [],
  summary: 'Leads with payments and Go.',
  ...patch,
});

const run = (out: TailorOutput, context = ctx) => {
  const composed = composeTailoring(requirements, out, context);
  tailorResumeResultSchema.parse(composed.result);
  return composed;
};

describe('groundRequirements', () => {
  it('keeps requirements quoted from the job description, once each', () => {
    expect(requirements.map((r) => r.quote)).toEqual([
      '5+ years building backend services in Go',
      'experience with PostgreSQL at scale',
      'Kafka or another event streaming platform',
      'experience leading a small team',
    ]);
  });
});

describe('composeTailoring', () => {
  it('proposes a new job-specific resume and leaves the source untouched with no changes', () => {
    const before = structuredClone(source);
    const { result } = run(output());
    expect(result.proposal).toMatchObject({
      applyTarget: { kind: 'new_resume', resumeType: 'job_specific', derivedFrom: source.source },
      changes: [],
      omissions: [],
      document: source.document,
    });
    expect(source).toEqual(before);
    // Without coverage every requirement is a visible gap.
    expect(result.unsupportedRequirementIds).toEqual(['req-1', 'req-2', 'req-3', 'req-4']);
    expect(result.requirements[0]?.evidence[0]).toMatchObject({ sourceKind: 'job_description' });
  });

  it('keeps support only with the candidate’s evidence', () => {
    const { result } = run(
      output({
        coverage: [
          {
            requirement: 2,
            status: 'supported',
            evidence: [{ ref: handle(view, 'legacy:tools:0', 'name'), quote: 'Kafka' }],
            note: null,
          },
          // A claim with nothing to cite is a gap.
          { requirement: 0, status: 'supported', evidence: [], note: null },
        ],
      }),
    );
    expect(result.coverage.map((c) => [c.requirementId, c.status])).toEqual([
      ['req-1', 'missing'],
      ['req-2', 'missing'],
      ['req-3', 'supported'],
      ['req-4', 'missing'],
    ]);
    expect(result.unsupportedRequirementIds).toEqual(['req-1', 'req-2', 'req-4']);
  });

  it('applies checked field changes to the document and copies everything else exactly', () => {
    const { result } = run(
      output({
        changes: [
          {
            entityId: ACME,
            field: 'achievements',
            value: null,
            lines: [
              {
                keep: null,
                text: 'Reduced checkout latency by 40%',
                from: [handle(view, ACME, 'achievements.0')],
                style: null,
              },
            ],
            reason: 'Leads with the result.',
          },
          // Blocked: claims a tool the candidate never named.
          {
            entityId: GLOBEX,
            field: 'responsibilities',
            value: null,
            lines: [
              {
                keep: null,
                text: 'Maintained billing jobs in Rust',
                from: [handle(view, GLOBEX, 'responsibilities.0')],
                style: null,
              },
            ],
            reason: 'Matches the job.',
          },
        ],
      }),
    );
    const document = result.proposal.document!;
    expect(document.experience[0]!.achievements).toEqual(['Reduced checkout latency by 40%']);
    expect(document.experience[1]).toEqual(source.document.experience[1]);
    expect(document.contacts).toEqual(source.document.contacts);
    expect(document.links).toEqual(source.document.links);
    expect(document.experience[0]!.description).toEqual(source.document.experience[0]!.description);
    expect(result.proposal.changes).toHaveLength(1);
    expect(result.proposal.changes[0]?.confirmation.required).toBe(true);
  });

  it('claims a skill only when the candidate’s own text names it', () => {
    const { result, warnings } = run(
      output({
        additions: [
          { section: 'tools', name: 'Kubernetes', reason: 'The job uses it.' },
          { section: 'skills', name: 'Rust', reason: 'The job asks for it.' },
        ],
      }),
    );
    expect(result.proposal.changes).toEqual([
      expect.objectContaining({
        type: 'add_entity',
        addition: { section: 'tools', entity: { id: 'added-tools-1', name: 'Kubernetes' } },
        evidence: [expect.objectContaining({ sourceKind: 'profile', excerpt: 'Kubernetes' })],
        confirmation: expect.objectContaining({ required: true }),
      }),
    ]);
    expect(result.proposal.document!.tools.map((t) => t.name)).toEqual(['Kafka', 'Kubernetes']);
    expect(warnings.map((w) => w.code)).toContain('unsupported_changes_blocked');
  });

  it('lists every omitted entry with its original value and drops changes to it', () => {
    const { result, warnings } = run(
      output({
        omissions: [
          { entityId: EDUCATION, reason: 'Less relevant than the roles.' },
          { entityId: 'legacy:links:0', reason: 'Links are not omitted here.' },
          { entityId: 'no-such-entry', reason: 'Unknown.' },
        ],
        changes: [
          {
            entityId: EDUCATION,
            field: 'description',
            value: null,
            lines: [{ keep: null, text: 'Studied computer science', from: [], style: null }],
            reason: 'Clearer.',
          },
        ],
      }),
    );
    expect(result.proposal.omissions).toEqual([
      {
        id: 'omission-1',
        section: 'education',
        entityId: EDUCATION,
        field: null,
        originalValue: source.document.education[0],
        reason: 'Less relevant than the roles.',
      },
    ]);
    expect(result.proposal.document!.education).toEqual([]);
    expect(result.proposal.document!.links).toEqual(source.document.links);
    expect(result.proposal.changes).toEqual([]);
    expect(warnings.map((w) => w.code)).toContain('omissions_dropped');
  });

  it('keeps gaps visible when no requirement could be read', () => {
    const composed = composeTailoring([], output(), ctx);
    tailorResumeResultSchema.parse(composed.result);
    expect(composed.result.requirements).toEqual([]);
    expect(composed.complete).toBe(false);
    expect(composed.warnings.map((w) => w.code)).toContain('no_requirements_found');
  });
});
