import {
  ApplyRequest,
  ApplyTargetError,
  OperationResult,
  Proposal,
  SourceRef,
  applyRequestSchema,
  applyTargetFor,
  checkApplySelection,
  proposalSchema,
} from '../src';
import { loadFixture, loadFixtures } from '../src/fixtures';
import { schemaFor } from './helpers';

const generated: SourceRef = {
  kind: 'resume',
  id: '7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c81',
  revision: 'r1',
  resumeType: 'general',
  state: 'generated',
  sourceResumeId: null,
};
const draft: SourceRef = {
  ...generated,
  state: 'draft',
  id: '8b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d92',
};
const profile: SourceRef = {
  kind: 'profile',
  id: '3f1c2b7e-8a4d-4c1e-9b2a-6d5e4f3a2b10',
  revision: 'p1',
};

describe('applyTargetFor', () => {
  it('never targets a generated resume directly', () => {
    expect(applyTargetFor('improve_resume', generated)).toEqual({
      kind: 'resume_draft_family',
      generatedResumeId: generated.id,
    });
  });

  it('updates a mutable draft at its revision', () => {
    expect(applyTargetFor('improve_resume', draft)).toEqual({
      kind: 'resume_draft',
      resumeId: draft.id,
      baseRevision: 'r1',
    });
  });

  it('makes job variants new resumes, whatever the source', () => {
    for (const source of [generated, draft, profile]) {
      expect(applyTargetFor('tailor_resume', source)).toEqual({
        kind: 'new_resume',
        resumeType: 'job_specific',
        derivedFrom: source,
      });
    }
  });

  it('rejects mismatched sources', () => {
    expect(() => applyTargetFor('improve_profile', draft)).toThrow(ApplyTargetError);
    expect(() => applyTargetFor('improve_resume', profile)).toThrow(ApplyTargetError);
  });
});

describe('proposal fixtures', () => {
  const proposalFixtures = loadFixtures('valid').filter((fixture) =>
    /^resultEnvelopeSchemas\.(improve_profile|improve_resume|tailor_resume)$/.test(fixture.schema),
  );

  it.each(proposalFixtures.map((fixture) => [fixture.name, fixture] as const))(
    '%s uses the only allowed apply target',
    (_name, fixture) => {
      const envelope = schemaFor(fixture).parse(fixture.payload) as {
        operation: 'improve_profile' | 'improve_resume' | 'tailor_resume';
        result: { proposal: Proposal };
      };
      const { proposal } = envelope.result;
      expect(proposal.applyTarget).toEqual(applyTargetFor(envelope.operation, proposal.source));
    },
  );
});

describe('checkApplySelection', () => {
  const tailored = schemaFor(loadFixture('valid', 'tailor-result-job-specific')).parse(
    loadFixture('valid', 'tailor-result-job-specific').payload,
  ) as { result: OperationResult<'tailor_resume'> };
  const proposal = tailored.result.proposal;
  const request = applyRequestSchema.parse(loadFixture('valid', 'apply-request-tailor').payload);
  const withChanges = (changes: Partial<ApplyRequest>): ApplyRequest => ({
    ...request,
    ...changes,
  });

  it('accepts a consistent selection', () => {
    expect(checkApplySelection(proposal, request)).toEqual([]);
  });

  it('requires every claim of a selected change to be confirmed', () => {
    expect(checkApplySelection(proposal, withChanges({ confirmedClaimIds: [] }))).toEqual([
      { code: 'unconfirmed_claim', changeId: 'change:tagline', claimId: 'claim:reliable' },
    ]);
  });

  it('rejects unknown ids, duplicates and a different target', () => {
    const issues = checkApplySelection(
      proposal,
      withChanges({
        selectedChangeIds: ['change:tagline', 'change:nope'],
        acceptedOmissionIds: ['omit:globex-billing', 'omit:globex-billing', 'omit:nope'],
        target: { kind: 'resume_draft', resumeId: draft.id, baseRevision: 'r1' },
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        { code: 'target_mismatch' },
        { code: 'unknown_change', id: 'change:nope' },
        { code: 'unknown_omission', id: 'omit:nope' },
        { code: 'duplicate_id', id: 'omit:globex-billing' },
      ]),
    );
  });

  it('needs a stable client draft id to create a resume', () => {
    expect(checkApplySelection(proposal, withChanges({ clientDraftId: null }))).toEqual([
      { code: 'missing_client_draft_id' },
    ]);
  });

  it('compares targets independently of key order', () => {
    if (
      proposal.applyTarget.kind !== 'new_resume' ||
      proposal.applyTarget.derivedFrom.kind !== 'profile'
    ) {
      throw new Error('fixture changed: expected a new_resume target derived from a profile');
    }
    const { derivedFrom } = proposal.applyTarget;
    const reordered = {
      derivedFrom: { revision: derivedFrom.revision, id: derivedFrom.id, kind: derivedFrom.kind },
      resumeType: 'job_specific' as const,
      kind: 'new_resume' as const,
    };
    expect(checkApplySelection(proposal, withChanges({ target: reordered }))).toEqual([]);
  });
});

describe('proposal ids', () => {
  const fixture = loadFixture('valid', 'improve-resume-result-generated-source');
  const envelope = fixture.payload as { result: { proposal: Proposal } };

  it('rejects a repeated change id', () => {
    const { proposal } = envelope.result;
    const repeated = { ...proposal, changes: [proposal.changes[0], proposal.changes[0]] };
    expect(proposalSchema.safeParse(repeated).success).toBe(false);
  });

  it('reports a change selected twice', () => {
    const tailoredFixture = loadFixture('valid', 'tailor-result-job-specific');
    const tailored = (tailoredFixture.payload as { result: { proposal: Proposal } }).result
      .proposal;
    const request = applyRequestSchema.parse(loadFixture('valid', 'apply-request-tailor').payload);
    expect(
      checkApplySelection(tailored, {
        ...request,
        selectedChangeIds: ['change:tagline', 'change:tagline'],
      }),
    ).toContainEqual({ code: 'duplicate_id', id: 'change:tagline' });
  });
});
