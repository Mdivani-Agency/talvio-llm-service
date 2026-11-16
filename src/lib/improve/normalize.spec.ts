import { improveResultSchema, type ContentDoc } from '@talvio/llm-contracts';

import { CONFLICTING_SOURCE, TAILOR_SOURCE, handle } from '../../test/fixtures/session';
import { careerView } from '../career/view';
import type { ImproveOutput } from '../prompts/improve';
import type { AnswerInput } from '../prompts/session-input';
import { normalizeImprovement, type ImproveContext } from './normalize';

const ACME = '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f51';
const GLOBEX = '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a62';
const PROPOSAL = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const view = careerView(TAILOR_SOURCE.document, { descriptionLines: true });
const acme = TAILOR_SOURCE.document.experience[0]!;

type Change = ImproveOutput['changes'][number];
const change = (patch: Partial<Change>): Change => ({
  entityId: ACME,
  field: 'achievements',
  value: null,
  lines: [],
  reason: 'Leads with the result.',
  ...patch,
});
const line = (patch: Partial<Change['lines'][number]>) => ({
  keep: null,
  text: null,
  from: [],
  style: null,
  ...patch,
});
const output = (changes: Change[], patch: Partial<ImproveOutput> = {}): ImproveOutput => ({
  changes,
  additions: [],
  summary: 'Tightens the Acme role.',
  ...patch,
});

const answer = (value: string): AnswerInput => ({
  handle: 'A1',
  questionId: 'r1-q1',
  answerRevisionId: '7c6d5e4f-3a2b-4c1d-8e9f-0a1b2c3d4e5f',
  topicKey: 'experience.team-size',
  question: 'How many engineers were on the payments team?',
  value,
});

const ctx = (patch: Partial<ImproveContext> = {}): ImproveContext => ({
  operation: 'improve_profile',
  proposalId: PROPOSAL,
  snapshot: TAILOR_SOURCE,
  sourceHash: 'a'.repeat(64),
  view,
  answers: [],
  sections: [],
  ...patch,
});

const run = (out: ImproveOutput, context: ImproveContext = ctx()) => {
  const normalized = normalizeImprovement(out, context);
  // Every result is a valid contract result.
  improveResultSchema.parse(normalized.result);
  return normalized;
};

describe('normalizeImprovement', () => {
  it('rewrites a description line, keeps the other lines exactly and asks to confirm new wording', () => {
    const { result } = run(
      output([
        change({
          field: 'description',
          lines: [
            line({ keep: handle(view, ACME, 'description.0') }),
            line({
              text: 'Reduced checkout latency by 40%',
              from: [handle(view, ACME, 'description.1')],
              style: 'bullet',
            }),
            line({ keep: handle(view, ACME, 'description.2') }),
          ],
        }),
      ]),
    );
    const [proposed] = result.proposal.changes;
    expect(result.proposal).toMatchObject({
      proposalId: PROPOSAL,
      source: TAILOR_SOURCE.source,
      applyTarget: { kind: 'profile', profileId: TAILOR_SOURCE.source.id },
      omissions: [],
      document: null,
    });
    expect(proposed).toMatchObject({
      type: 'field',
      changeKind: 'rewrite',
      target: { section: 'experience', entityId: ACME, field: 'description' },
      // The precondition is the exact original value.
      originalValue: acme.description,
      confirmation: {
        required: true,
        claims: [{ id: 'claim-1', text: 'Reduced checkout latency by 40%' }],
      },
    });
    const doc = proposed?.type === 'field' ? (proposed.proposedValue as ContentDoc) : null;
    expect(doc).toEqual({
      type: 'doc',
      blocks: [
        acme.description!.blocks[0],
        {
          type: 'bulletList',
          items: [
            [{ text: 'Reduced checkout latency by 40%' }],
            // Kept with its italic mark.
            [{ text: 'Mentored ', marks: ['italic'] }, { text: 'three engineers' }],
          ],
        },
      ],
    });
    expect(proposed!.evidence.map((e) => e.field)).toEqual(['description.1']);
  });

  it('never erases lines: an empty or partial answer puts every original line back', () => {
    const empty = run(output([change({ field: 'responsibilities', lines: [] })]));
    expect(empty.result.proposal.changes).toEqual([]);
    expect(empty.result.proposal.summary).toBe('No changes are suggested.');

    const partial = run(
      output([
        change({
          field: 'description',
          lines: [
            line({
              text: 'Mentored three engineers on the payments platform',
              from: [handle(view, ACME, 'description.2')],
              style: 'bullet',
            }),
          ],
        }),
      ]),
    );
    const [proposed] = partial.result.proposal.changes;
    const doc = proposed?.type === 'field' ? (proposed.proposedValue as ContentDoc) : null;
    expect(doc!.blocks).toEqual([
      acme.description!.blocks[0],
      {
        type: 'bulletList',
        items: [
          [{ text: 'Cut checkout latency by 40%' }],
          [{ text: 'Mentored three engineers on the payments platform' }],
        ],
      },
    ]);
  });

  it('drops a second rewrite of a line already kept', () => {
    const achievement = handle(view, ACME, 'achievements.0');
    const { result, warnings } = run(
      output([
        change({
          lines: [
            line({ keep: achievement }),
            line({ text: 'Halved checkout latency', from: [achievement] }),
          ],
        }),
      ]),
    );
    expect(result.proposal.changes).toEqual([]);
    expect(warnings.map((w) => w.code)).toEqual(['changes_dropped']);
  });

  it('blocks a line with a number, name or credential the profile and answers do not contain', () => {
    const { result, warnings } = run(
      output([
        change({
          lines: [
            line({
              text: 'Cut checkout latency by 60%',
              from: [handle(view, ACME, 'achievements.0')],
            }),
          ],
        }),
        change({
          field: 'responsibilities',
          lines: [
            line({
              text: 'Own the payments API on Kubernetes',
              from: [handle(view, ACME, 'responsibilities.0')],
            }),
          ],
        }),
        change({
          entityId: GLOBEX,
          field: 'responsibilities',
          lines: [
            line({
              text: 'Maintained billing jobs as a certified engineer',
              from: [handle(view, GLOBEX, 'responsibilities.0')],
            }),
          ],
        }),
      ]),
    );
    expect(result.proposal.changes).toEqual([]);
    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'unsupported_changes_blocked',
        message: expect.stringMatching(/^3 suggested lines/),
      }),
    ]);
  });

  it('adds a fact from an answer as a factual addition the user confirms, with answer evidence', () => {
    const { result } = run(
      output([
        change({
          lines: [
            line({ keep: handle(view, ACME, 'achievements.0') }),
            line({ text: 'Led a team of 6 engineers', from: [] }),
          ],
        }),
      ]),
      ctx({ answers: [answer('There were 6 engineers on the team.')] }),
    );
    const [proposed] = result.proposal.changes;
    expect(proposed).toMatchObject({
      changeKind: 'factual_addition',
      proposedValue: ['Cut checkout latency by 40%', 'Led a team of 6 engineers'],
      confirmation: { required: true, claims: [{ text: 'Led a team of 6 engineers' }] },
    });
    expect(proposed!.evidence).toContainEqual(
      expect.objectContaining({ sourceKind: 'answer', questionId: 'r1-q1', excerpt: '6' }),
    );

    // Without the answer (skipped questions are never passed in), the same number is blocked.
    expect(
      run(output([change({ lines: [line({ text: 'Led a team of 6 engineers', from: [] })] })]))
        .result.proposal.changes,
    ).toEqual([]);
  });

  it('needs no confirmation for a line that only reorders or trims its own words', () => {
    const { result } = run(
      output([
        change({
          field: 'responsibilities',
          entityId: GLOBEX,
          lines: [
            line({
              text: 'Billing jobs: maintained',
              from: [handle(view, GLOBEX, 'responsibilities.0')],
            }),
          ],
        }),
      ]),
    );
    expect(result.proposal.changes[0]).toMatchObject({
      changeKind: 'rewrite',
      confirmation: { required: false, claims: [] },
    });
  });

  it('asks to confirm a line that drops a hedge or negation', () => {
    const source = structuredClone(TAILOR_SOURCE);
    source.document.experience[1]!.responsibilities = ['Helped maintain billing jobs'];
    const hedged = careerView(source.document, { descriptionLines: true });
    const { result } = run(
      output([
        change({
          entityId: GLOBEX,
          field: 'responsibilities',
          lines: [
            line({
              text: 'Maintained billing jobs',
              from: [handle(hedged, GLOBEX, 'responsibilities.0')],
            }),
          ],
        }),
      ]),
      ctx({ snapshot: source, view: hedged }),
    );
    expect(result.proposal.changes[0]?.confirmation.required).toBe(true);
  });

  it('always asks to confirm a change to an entry whose facts conflict', () => {
    const conflicted = careerView(CONFLICTING_SOURCE.document, { descriptionLines: true });
    const { result } = run(
      output([
        change({
          entityId: 'exp-conflict-1',
          lines: [
            line({
              text: 'Managed a team of 12 engineers',
              from: [handle(conflicted, 'exp-conflict-1', 'achievements.0')],
            }),
          ],
        }),
      ]),
      ctx({ snapshot: CONFLICTING_SOURCE, view: conflicted }),
    );
    // The text is unchanged, so the line is kept and there is no change at all.
    expect(result.proposal.changes).toEqual([]);

    const reworded = run(
      output([
        change({
          entityId: 'exp-conflict-1',
          lines: [
            line({
              text: 'Engineers managed: a team of 12',
              from: [handle(conflicted, 'exp-conflict-1', 'achievements.0')],
            }),
          ],
        }),
      ]),
      ctx({ snapshot: CONFLICTING_SOURCE, view: conflicted }),
    ).result.proposal.changes[0];
    expect(reworded?.confirmation).toEqual({
      required: true,
      claims: [
        {
          id: 'claim-1',
          text: 'This full-time role overlaps another full-time role. Confirm the facts this change keeps.',
        },
        // Its number makes the line a claim too.
        { id: 'claim-2', text: 'Engineers managed: a team of 12' },
      ],
    });
  });

  it('changes only targetable fields of known entities in the requested sections', () => {
    const { result, warnings } = run(
      output([
        change({ entityId: 'no-such-entity' }),
        change({ entityId: GLOBEX, field: 'role' }),
        change({ entityId: null, field: 'tagline', value: 'Backend engineer focused on payments' }),
        change({ entityId: null, field: 'role', value: 'Senior Backend Engineer' }),
      ]),
      ctx({ sections: ['experience', 'recommendations'] }),
    );
    expect(result.proposal.changes).toEqual([]);
    expect(warnings.map((w) => w.code)).toEqual(['changes_dropped', 'section_not_improved']);
  });

  it('asks to confirm any change of role', () => {
    const { result } = run(
      output([change({ entityId: null, field: 'role', value: 'Backend Engineer' })]),
    );
    expect(result.proposal.changes[0]).toMatchObject({
      target: { section: 'person', entityId: null, field: 'role' },
      originalValue: 'Senior Backend Engineer',
      proposedValue: 'Backend Engineer',
      confirmation: { required: true, claims: [{ text: 'Backend Engineer' }] },
    });
  });

  it('adds skills, tools and languages only when an answer names them and they are new', () => {
    const { result, warnings } = run(
      output([], {
        additions: [
          { section: 'tools', name: 'Terraform', reason: 'You use it.' },
          { section: 'skills', name: 'Go', reason: 'Already listed.' },
          { section: 'languages', name: 'Georgian', reason: 'Not in any answer.' },
        ],
      }),
      ctx({ answers: [answer('I set up our Terraform modules.')] }),
    );
    expect(result.proposal.changes).toEqual([
      expect.objectContaining({
        type: 'add_entity',
        addition: { section: 'tools', entity: { id: 'added-tools-1', name: 'Terraform' } },
        confirmation: {
          required: true,
          claims: [expect.objectContaining({ text: expect.stringContaining('Terraform') })],
        },
      }),
    ]);
    expect(warnings.map((w) => w.code)).toEqual(['unsupported_changes_blocked', 'changes_dropped']);
  });

  it('builds the apply target from the source: a generated resume edits its draft family', () => {
    const resume = structuredClone(TAILOR_SOURCE);
    resume.source = {
      kind: 'resume',
      id: TAILOR_SOURCE.source.id,
      revision: TAILOR_SOURCE.source.revision,
      resumeType: 'general',
      state: 'generated',
      sourceResumeId: null,
    };
    const { result } = run(output([]), ctx({ operation: 'improve_resume', snapshot: resume }));
    expect(result.proposal.applyTarget).toEqual({
      kind: 'resume_draft_family',
      generatedResumeId: TAILOR_SOURCE.source.id,
    });
    expect(() => run(output([]), ctx({ operation: 'improve_resume' }))).toThrow();
  });

  it('keeps unchanged rich text and never touches fields it was not asked to change', () => {
    const { result } = run(
      output([
        change({
          field: 'description',
          lines: [
            line({ keep: handle(view, ACME, 'description.0') }),
            line({ keep: handle(view, ACME, 'description.1') }),
            line({ keep: handle(view, ACME, 'description.2') }),
          ],
        }),
      ]),
    );
    expect(result.proposal.changes).toEqual([]);
  });
});
