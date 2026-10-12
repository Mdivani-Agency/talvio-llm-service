import { contextRevisionSchema, sessionSchema } from '@talvio/llm-contracts';
import { loadFixture } from '@talvio/llm-contracts/fixtures';

import { USER_A, USER_B, event, json, testApp, type TestApp } from '../../test/helpers';

const improveSession = loadFixture('valid', 'session-create-improve-generated-resume')
  .payload as Record<string, any>;
const tailorSession = loadFixture('valid', 'session-create-tailor-with-jd').payload as Record<
  string,
  any
>;

describe('sessions', () => {
  let app: TestApp;
  let tokenA: string;
  let tokenB: string;

  beforeEach(async () => {
    app = await testApp();
    tokenA = await app.tokenFor(USER_A);
    tokenB = await app.tokenFor(USER_B);
  });

  const create = (body: unknown, tokenValue = tokenA) =>
    app.handle(event('POST', '/v1/sessions', { body, token: tokenValue }));

  it('creates a session with server-computed hashes and replays by clientRequestId', async () => {
    const first = await create(improveSession);
    expect(first.statusCode).toBe(201);
    const session = sessionSchema.parse(json(first.body));
    expect(session.latestContext.jobDescriptionHash).toBeNull();

    const replay = sessionSchema.parse(json((await create(improveSession)).body));
    expect(replay.sessionId).toBe(session.sessionId);

    const changed = {
      ...improveSession,
      source: {
        ...improveSession.source,
        document: { ...improveSession.source.document, skills: [] },
      },
    };
    expect((await create(changed)).statusCode).toBe(409);
  });

  it('requires a job description for tailoring', async () => {
    expect((await create({ ...tailorSession, jobDescription: null })).statusCode).toBe(400);
    const session = sessionSchema.parse(json((await create(tailorSession)).body));
    expect(session.latestContext.jobDescriptionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hides another user's session", async () => {
    const { sessionId, latestContext } = json((await create(improveSession)).body) as any;
    const params = { sessionId };
    expect(
      (await app.handle(event('GET', '/v1/sessions/{sessionId}', { params, token: tokenB })))
        .statusCode,
    ).toBe(404);
    const context = await app.handle(
      event('POST', '/v1/sessions/{sessionId}/contexts', {
        params,
        body: {
          schemaVersion: '1.0',
          baseContextRevisionId: latestContext.contextRevisionId,
          source: improveSession.source,
          jobDescription: null,
        },
        token: tokenB,
      }),
    );
    expect(context.statusCode).toBe(404);
    expect(
      (await app.handle(event('DELETE', '/v1/sessions/{sessionId}', { params, token: tokenB })))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.handle(event('DELETE', '/v1/sessions/{sessionId}', { params, token: tokenA })))
        .statusCode,
    ).toBe(204);
  });

  it('creates context revisions only from the latest one', async () => {
    const { sessionId, latestContext } = json((await create(improveSession)).body) as any;
    const revise = (base: string) =>
      app.handle(
        event('POST', '/v1/sessions/{sessionId}/contexts', {
          params: { sessionId },
          body: {
            schemaVersion: '1.0',
            baseContextRevisionId: base,
            source: improveSession.source,
            jobDescription: null,
          },
          token: tokenA,
        }),
      );
    const next = await revise(latestContext.contextRevisionId);
    expect(next.statusCode).toBe(201);
    expect(contextRevisionSchema.parse(json(next.body)).contextRevisionId).not.toBe(
      latestContext.contextRevisionId,
    );
    expect((await revise(latestContext.contextRevisionId)).statusCode).toBe(409);
  });

  it('accepts answers only for issued question ids, once each', async () => {
    const { sessionId, latestContext } = json((await create(improveSession)).body) as any;
    const set = app.store.testing.addQuestionSet({
      sessionId,
      sourceHash: latestContext.sourceHash,
      jobDescriptionHash: latestContext.jobDescriptionHash,
      round: 1,
      questions: [
        {
          id: 'q:lead-team',
          topicKey: 'leadership',
          prompt: 'Have you led a team?',
          guidance: null,
          reason: 'Relevant.',
          targetSection: null,
          targetEntityId: null,
          requirementIds: [],
        },
      ],
    });
    const answer = (answers: unknown[], base = latestContext.contextRevisionId) =>
      app.handle(
        event('POST', '/v1/sessions/{sessionId}/answers', {
          params: { sessionId },
          body: {
            schemaVersion: '1.0',
            baseContextRevisionId: base,
            questionSetId: set.questionSetId,
            answers,
          },
          token: tokenA,
        }),
      );

    expect((await answer([{ questionId: 'q:invented', status: 'skipped' }])).statusCode).toBe(400);
    expect(
      (
        await answer([
          { questionId: 'q:lead-team', status: 'skipped' },
          { questionId: 'q:lead-team', status: 'answered', value: 'Yes' },
        ])
      ).statusCode,
    ).toBe(400);

    const saved = await answer([
      { questionId: 'q:lead-team', status: 'answered', value: 'A team of 4.' },
    ]);
    expect(saved.statusCode).toBe(201);
    expect(contextRevisionSchema.parse(json(saved.body)).answerRevisionId).not.toBeNull();
    expect((await answer([{ questionId: 'q:lead-team', status: 'skipped' }])).statusCode).toBe(409);
  });
});

describe('context changes', () => {
  let app: TestApp;
  let tokenA: string;

  beforeEach(async () => {
    app = await testApp();
    tokenA = await app.tokenFor(USER_A);
  });

  const revise = (
    sessionId: string,
    base: string,
    jobDescription: unknown,
    source = improveSession.source,
  ) =>
    app.handle(
      event('POST', '/v1/sessions/{sessionId}/contexts', {
        params: { sessionId },
        body: { schemaVersion: '1.0', baseContextRevisionId: base, source, jobDescription },
        token: tokenA,
      }),
    );

  it('keeps a job description on tailoring sessions', async () => {
    const { sessionId, latestContext } = json(
      (await app.handle(event('POST', '/v1/sessions', { body: tailorSession, token: tokenA })))
        .body,
    ) as any;
    const response = await revise(sessionId, latestContext.contextRevisionId, null);
    expect(response.statusCode).toBe(400);
    expect(json(response.body)?.error.issues).toEqual([
      { path: 'jobDescription', message: 'Required for tailoring.' },
    ]);
    expect(
      (await revise(sessionId, latestContext.contextRevisionId, tailorSession.jobDescription))
        .statusCode,
    ).toBe(201);
  });

  it('refuses answers to questions issued for an earlier source', async () => {
    const { sessionId, latestContext } = json(
      (await app.handle(event('POST', '/v1/sessions', { body: improveSession, token: tokenA })))
        .body,
    ) as any;
    const set = app.store.testing.addQuestionSet({
      sessionId,
      sourceHash: latestContext.sourceHash,
      jobDescriptionHash: latestContext.jobDescriptionHash,
      round: 1,
      questions: [
        {
          id: 'q:lead-team',
          topicKey: 'leadership',
          prompt: 'Have you led a team?',
          guidance: null,
          reason: 'Relevant.',
          targetSection: null,
          targetEntityId: null,
          requirementIds: [],
        },
      ],
    });
    const changedSource = {
      ...improveSession.source,
      document: { ...improveSession.source.document, skills: [] },
    };
    const next = json(
      (await revise(sessionId, latestContext.contextRevisionId, null, changedSource)).body,
    ) as any;

    const response = await app.handle(
      event('POST', '/v1/sessions/{sessionId}/answers', {
        params: { sessionId },
        body: {
          schemaVersion: '1.0',
          baseContextRevisionId: next.contextRevisionId,
          questionSetId: set.questionSetId,
          answers: [{ questionId: 'q:lead-team', status: 'skipped' }],
        },
        token: tokenA,
      }),
    );
    expect(response.statusCode).toBe(409);
    expect(json(response.body)?.error.code).toBe('stale_context');
  });
});

describe('documents', () => {
  let app: TestApp;
  let tokenA: string;
  let tokenB: string;
  const request = {
    schemaVersion: '1.0',
    fileName: 'cv.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1000,
    sha256: 'b'.repeat(64),
  };

  beforeEach(async () => {
    app = await testApp();
    tokenA = await app.tokenFor(USER_A);
    tokenB = await app.tokenFor(USER_B);
  });

  it('registers an upload and returns a private grant', async () => {
    const response = await app.handle(
      event('POST', '/v1/documents', { body: request, token: tokenA }),
    );
    expect(response.statusCode).toBe(201);
    expect(json(response.body)).toMatchObject({
      document: { status: 'awaiting_upload', contentType: 'application/pdf' },
      upload: { method: 'PUT' },
    });
  });

  it('rejects unsupported types and oversized files', async () => {
    const docx = await app.handle(
      event('POST', '/v1/documents', {
        body: { ...request, contentType: 'application/msword' },
        token: tokenA,
      }),
    );
    expect(docx.statusCode).toBe(415);
    const big = await app.handle(
      event('POST', '/v1/documents', {
        body: { ...request, sizeBytes: 10 * 1024 * 1024 + 1 },
        token: tokenA,
      }),
    );
    expect(big.statusCode).toBe(413);
  });

  it('completes idempotently and only for the owner', async () => {
    const documentId = json(
      (await app.handle(event('POST', '/v1/documents', { body: request, token: tokenA }))).body,
    )?.document.documentId as string;
    const complete = (tokenValue: string) =>
      app.handle(
        event('POST', '/v1/documents/{documentId}/complete', {
          params: { documentId },
          token: tokenValue,
        }),
      );
    expect((await complete(tokenB)).statusCode).toBe(404);
    expect(json((await complete(tokenA)).body)?.status).toBe('validating');
    expect(json((await complete(tokenA)).body)?.status).toBe('validating');
    expect(
      (
        await app.handle(
          event('GET', '/v1/documents/{documentId}', { params: { documentId }, token: tokenB }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.handle(
          event('DELETE', '/v1/documents/{documentId}', { params: { documentId }, token: tokenA }),
        )
      ).statusCode,
    ).toBe(204);
  });
});
