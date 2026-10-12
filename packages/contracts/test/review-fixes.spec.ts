import {
  careerDocumentSchema,
  jobSchema,
  partialDateSchema,
  proposedChangeSchema,
  resultEnvelopeSchemas,
} from '../src';
import { loadFixture } from '../src/fixtures';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('entity additions', () => {
  const envelope = loadFixture('valid', 'improve-resume-result-generated-source').payload as {
    result: { proposal: { changes: Array<Record<string, unknown>> } };
  };
  const addition = envelope.result.proposal.changes.find((change) => change.type === 'add_entity');

  it('always require confirmation of at least one claim', () => {
    expect(proposedChangeSchema.safeParse(addition).success).toBe(true);
    const unconfirmed = { ...addition, confirmation: { required: false, claims: [] } };
    expect(proposedChangeSchema.safeParse(unconfirmed).success).toBe(false);
    const noClaims = { ...addition, confirmation: { required: true, claims: [] } };
    expect(proposedChangeSchema.safeParse(noClaims).success).toBe(false);
  });
});

describe('apply target in results', () => {
  it('rejects a generated resume as a direct improve_resume target', () => {
    const fixture = clone(
      loadFixture('valid', 'improve-resume-result-generated-source').payload,
    ) as {
      sourceRevision: string;
      result: { proposal: { source: { id: string }; applyTarget: unknown } };
    };
    fixture.result.proposal.applyTarget = {
      kind: 'resume_draft',
      resumeId: fixture.result.proposal.source.id,
      baseRevision: fixture.sourceRevision,
    };
    expect(resultEnvelopeSchemas.improve_resume.safeParse(fixture).success).toBe(false);
  });

  it('rejects a tailoring result that targets the source profile', () => {
    const fixture = clone(loadFixture('valid', 'tailor-result-job-specific').payload) as {
      result: { proposal: { source: { id: string; revision: string }; applyTarget: unknown } };
    };
    const { source } = fixture.result.proposal;
    fixture.result.proposal.applyTarget = {
      kind: 'profile',
      profileId: source.id,
      baseRevision: source.revision,
    };
    expect(resultEnvelopeSchemas.tailor_resume.safeParse(fixture).success).toBe(false);
  });

  it('rejects improve_profile results whose source is a resume', () => {
    const fixture = clone(loadFixture('valid', 'improve-profile-result').payload) as {
      result: { proposal: { source: unknown } };
    };
    const resume = loadFixture('valid', 'improve-resume-result-draft-source').payload as {
      result: { proposal: { source: unknown } };
    };
    fixture.result.proposal.source = resume.result.proposal.source;
    expect(resultEnvelopeSchemas.improve_profile.safeParse(fixture).success).toBe(false);
  });
});

describe('context bindings', () => {
  it('are required on session results and optional on parse results', () => {
    const questions = clone(loadFixture('valid', 'questions-result').payload) as Record<
      string,
      unknown
    >;
    for (const field of ['contextRevisionId', 'contextHash', 'sourceRevision']) {
      expect(
        resultEnvelopeSchemas.generate_questions.safeParse({ ...questions, [field]: null }).success,
      ).toBe(false);
    }
    const parse = loadFixture('valid', 'parse-result-partial-profile').payload;
    expect(resultEnvelopeSchemas.parse_document.safeParse(parse).success).toBe(true);
  });
});

describe('job result binding', () => {
  it('rejects a result that belongs to another job', () => {
    const result = loadFixture('valid', 'questions-result').payload as { jobId: string };
    const job = {
      jobId: '00000000-0000-4000-8000-000000000001',
      operation: 'generate_questions',
      status: 'succeeded',
      stage: 'done',
      sessionId: null,
      contextRevisionId: null,
      parentJobId: null,
      createdAt: '2026-10-12T10:00:00Z',
      updatedAt: '2026-10-12T10:00:30Z',
      deadlineAt: '2026-10-12T10:10:00Z',
      pollAfterMs: null,
      result,
      error: null,
    };
    expect(jobSchema.safeParse(job).success).toBe(false);
    expect(jobSchema.safeParse({ ...job, jobId: result.jobId }).success).toBe(true);
  });
});

describe('calendar dates', () => {
  it.each(['2023-02-29', '2024-04-31', '2021-06-31'])('rejects %s', (value) => {
    expect(partialDateSchema.safeParse(value).success).toBe(false);
  });
  it.each(['2024-02-29', '2024-04-30', '2024-04', '2024'])('accepts %s', (value) => {
    expect(partialDateSchema.safeParse(value).success).toBe(true);
  });
});

describe('career entity ids', () => {
  it('are unique across sections', () => {
    const session = loadFixture('valid', 'session-create-improve-generated-resume').payload as {
      source: { document: { experience: Array<{ id: string }>; skills: Array<{ id: string }> } };
    };
    const document = clone(session.source.document);
    expect(careerDocumentSchema.safeParse(document).success).toBe(true);
    const sameSection = clone(document);
    sameSection.experience[1]!.id = sameSection.experience[0]!.id;
    expect(careerDocumentSchema.safeParse(sameSection).success).toBe(false);
    const acrossSections = clone(document);
    acrossSections.skills[0]!.id = acrossSections.experience[0]!.id;
    expect(careerDocumentSchema.safeParse(acrossSections).success).toBe(false);
  });
});
