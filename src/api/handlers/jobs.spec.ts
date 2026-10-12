import { jobAcceptedSchema, jobSchema } from '@talvio/llm-contracts';
import { loadFixture } from '@talvio/llm-contracts/fixtures';

import { USER_A, USER_B, event, json, testApp, type TestApp } from '../../test/helpers';

const sessionFixture = loadFixture('valid', 'session-create-improve-generated-resume')
  .payload as Record<string, unknown>;

const parseRequest = (key: string, text = 'Nino Beridze\nBackend engineer') => ({
  schemaVersion: '1.0',
  clientRequestId: key,
  operation: 'parse_document',
  input: { kind: 'text', text, extraction: null },
});

describe('POST /v1/jobs', () => {
  let app: TestApp;
  let tokenA: string;
  let tokenB: string;

  const post = (body: unknown, tokenValue: string, key?: string) =>
    app.handle(
      event('POST', '/v1/jobs', {
        body,
        token: tokenValue,
        headers: key ? { 'Idempotency-Key': key } : {},
      }),
    );

  beforeEach(async () => {
    app = await testApp();
    tokenA = await app.tokenFor(USER_A);
    tokenB = await app.tokenFor(USER_B);
  });

  async function openSession(tokenValue: string, clientRequestId = 'session-12345678') {
    const response = await app.handle(
      event('POST', '/v1/sessions', {
        body: { ...sessionFixture, clientRequestId },
        token: tokenValue,
      }),
    );
    expect(response.statusCode).toBe(201);
    return json(response.body) as {
      sessionId: string;
      latestContext: { contextRevisionId: string };
    };
  }

  const improve = (
    key: string,
    sessionId: string,
    contextRevisionId: string,
    parentJobId: string | null = null,
  ) => ({
    schemaVersion: '1.0',
    clientRequestId: key,
    operation: 'improve_resume',
    sessionId,
    contextRevisionId,
    parentJobId,
    input: { sections: [], targetRole: null },
  });

  it('admits a valid job and returns 202 with a status URL', async () => {
    const response = await post(parseRequest('parse-00000001'), tokenA, 'parse-00000001');
    expect(response.statusCode).toBe(202);
    const accepted = jobAcceptedSchema.parse(json(response.body));
    expect(accepted).toMatchObject({ status: 'queued', replayed: false });
    expect(accepted.statusUrl).toBe(`/llm/v1/jobs/${accepted.jobId}`);

    const job = await app.handle(
      event('GET', '/v1/jobs/{jobId}', { params: { jobId: accepted.jobId }, token: tokenA }),
    );
    expect(job.statusCode).toBe(200);
    expect(jobSchema.parse(json(job.body))).toMatchObject({ status: 'queued', result: null });
  });

  it('requires an Idempotency-Key equal to clientRequestId', async () => {
    const missing = await post(parseRequest('parse-00000001'), tokenA);
    expect(json(missing.body)?.error.code).toBe('idempotency_key_required');

    const malformed = await post(parseRequest('parse-00000001'), tokenA, 'bad key!');
    expect(malformed.statusCode).toBe(400);

    const mismatch = await post(parseRequest('parse-00000001'), tokenA, 'parse-00000002');
    expect(mismatch.statusCode).toBe(400);
    expect(json(mismatch.body)?.error.issues).toEqual([
      { path: 'clientRequestId', message: 'Must equal the Idempotency-Key header.' },
    ]);
  });

  it('replays the same request and rejects a different body with the same key', async () => {
    const first = json((await post(parseRequest('parse-00000001'), tokenA, 'parse-00000001')).body);
    const replay = await post(parseRequest('parse-00000001'), tokenA, 'parse-00000001');
    expect(replay.statusCode).toBe(202);
    expect(json(replay.body)).toMatchObject({ jobId: first?.jobId, replayed: true });

    const conflict = await post(
      parseRequest('parse-00000001', 'different text'),
      tokenA,
      'parse-00000001',
    );
    expect(conflict.statusCode).toBe(409);
    expect(json(conflict.body)?.error.code).toBe('idempotency_conflict');
  });

  it('scopes idempotency keys to their owner', async () => {
    const first = json((await post(parseRequest('parse-00000001'), tokenA, 'parse-00000001')).body);
    const other = json((await post(parseRequest('parse-00000001'), tokenB, 'parse-00000001')).body);
    expect(other).toMatchObject({ replayed: false });
    expect(other?.jobId).not.toBe(first?.jobId);
  });

  it('validates the operation schema and reports paths without values', async () => {
    const text = 'x'.repeat(100_001);
    const response = await post(parseRequest('parse-00000001', text), tokenA, 'parse-00000001');
    expect(response.statusCode).toBe(400);
    expect(json(response.body)?.error.issues).toEqual([
      { path: 'input.text', message: 'Too long or too large.' },
    ]);
    expect(response.body).not.toContain('xxxx');

    const unknownField = await post(
      { ...parseRequest('parse-00000002'), modelId: 'x' },
      tokenA,
      'parse-00000002',
    );
    expect(json(unknownField.body)?.error.issues).toEqual([
      { path: '(root)', message: 'Unknown field.' },
    ]);
  });

  it("refuses another user's document", async () => {
    const created = await app.handle(
      event('POST', '/v1/documents', {
        body: {
          schemaVersion: '1.0',
          fileName: 'cv.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1000,
          sha256: 'a'.repeat(64),
        },
        token: tokenA,
      }),
    );
    const documentId = json(created.body)?.document.documentId as string;
    const request = { ...parseRequest('parse-00000003'), input: { kind: 'document', documentId } };

    expect((await post(request, tokenB, 'parse-00000003')).statusCode).toBe(404);
    const notReady = await post(request, tokenA, 'parse-00000003');
    expect(json(notReady.body)?.error.code).toBe('unusable_document');

    app.store.testing.setDocument(documentId, { status: 'ready' });
    expect((await post(request, tokenA, 'parse-00000003')).statusCode).toBe(202);
  });

  it("refuses another user's session and parent job", async () => {
    const sessionA = await openSession(tokenA);
    const contextA = sessionA.latestContext.contextRevisionId;

    const foreign = await post(
      improve('improve-0001', sessionA.sessionId, contextA),
      tokenB,
      'improve-0001',
    );
    expect(foreign.statusCode).toBe(404);

    const ownJob = json(
      (await post(improve('improve-0002', sessionA.sessionId, contextA), tokenA, 'improve-0002'))
        .body,
    );
    const sessionB = await openSession(tokenB, 'session-87654321');
    const borrowedParent = await post(
      improve(
        'improve-0003',
        sessionB.sessionId,
        sessionB.latestContext.contextRevisionId,
        ownJob?.jobId,
      ),
      tokenB,
      'improve-0003',
    );
    expect(borrowedParent.statusCode).toBe(404);
  });

  it('rejects a stale context revision', async () => {
    const session = await openSession(tokenA);
    const stale = session.latestContext.contextRevisionId;
    const newer = await app.handle(
      event('POST', '/v1/sessions/{sessionId}/contexts', {
        params: { sessionId: session.sessionId },
        body: {
          schemaVersion: '1.0',
          baseContextRevisionId: stale,
          source: sessionFixture.source,
          jobDescription: null,
        },
        token: tokenA,
      }),
    );
    expect(newer.statusCode).toBe(201);
    const response = await post(
      improve('improve-0004', session.sessionId, stale),
      tokenA,
      'improve-0004',
    );
    expect(response.statusCode).toBe(409);
    expect(json(response.body)?.error.code).toBe('stale_context');
  });

  it('requires an analysis dependency to be an analyze_resume job of the same session', async () => {
    const session = await openSession(tokenA);
    const contextId = session.latestContext.contextRevisionId;
    const improveJob = json(
      (await post(improve('improve-0005', session.sessionId, contextId), tokenA, 'improve-0005'))
        .body,
    );
    const questions = {
      schemaVersion: '1.0',
      clientRequestId: 'questions-0001',
      operation: 'generate_questions',
      sessionId: session.sessionId,
      contextRevisionId: contextId,
      parentJobId: null,
      input: { analysisJobId: improveJob?.jobId, round: 1, maxQuestions: 5 },
    };
    const response = await post(questions, tokenA, 'questions-0001');
    expect(response.statusCode).toBe(400);
    expect(json(response.body)?.error.issues?.[0]?.path).toBe('input.analysisJobId');
  });
});

describe('job lifecycle routes', () => {
  let app: TestApp;
  let tokenA: string;
  let tokenB: string;
  let jobId: string;

  beforeEach(async () => {
    app = await testApp();
    tokenA = await app.tokenFor(USER_A);
    tokenB = await app.tokenFor(USER_B);
    const response = await app.handle(
      event('POST', '/v1/jobs', {
        body: parseRequest('parse-00000009'),
        token: tokenA,
        headers: { 'Idempotency-Key': 'parse-00000009' },
      }),
    );
    jobId = json(response.body)?.jobId;
  });

  const call = (method: string, resource: string, tokenValue: string) =>
    app.handle(event(method, resource, { params: { jobId }, token: tokenValue }));

  it("hides another user's job on every job route", async () => {
    for (const [method, resource] of [
      ['GET', '/v1/jobs/{jobId}'],
      ['POST', '/v1/jobs/{jobId}/cancel'],
      ['POST', '/v1/jobs/{jobId}/retry'],
      ['DELETE', '/v1/jobs/{jobId}'],
    ] as const) {
      expect((await call(method, resource, tokenB)).statusCode).toBe(404);
    }
    const list = json((await app.handle(event('GET', '/v1/jobs', { token: tokenB }))).body);
    expect(list).toEqual({ jobs: [], nextCursor: null });
  });

  it('cancels idempotently', async () => {
    const first = json((await call('POST', '/v1/jobs/{jobId}/cancel', tokenA)).body);
    const second = json((await call('POST', '/v1/jobs/{jobId}/cancel', tokenA)).body);
    expect(first).toMatchObject({ status: 'cancelled', pollAfterMs: null });
    expect(second).toEqual(first);
  });

  it('retries only retryable failures before the deadline', async () => {
    expect((await call('POST', '/v1/jobs/{jobId}/retry', tokenA)).statusCode).toBe(409);

    app.store.testing.setJob(jobId, {
      status: 'failed',
      stage: 'done',
      error: {
        code: 'budget_exceeded',
        message: 'Too long.',
        retryable: false,
        correlationId: 'corr-1',
      },
    });
    expect((await call('POST', '/v1/jobs/{jobId}/retry', tokenA)).statusCode).toBe(409);

    app.store.testing.setJob(jobId, {
      error: {
        code: 'dependency_unavailable',
        message: 'Later.',
        retryable: true,
        correlationId: 'corr-2',
      },
    });
    expect((await call('POST', '/v1/jobs/{jobId}/retry', tokenA)).statusCode).toBe(202);

    app.store.testing.setJob(jobId, {
      status: 'failed',
      error: {
        code: 'dependency_unavailable',
        message: 'Later.',
        retryable: true,
        correlationId: 'corr-3',
      },
      deadlineAt: new Date(Date.now() - 1_000),
    });
    expect((await call('POST', '/v1/jobs/{jobId}/retry', tokenA)).statusCode).toBe(409);
  });

  it('never returns a job record that breaks the contract', async () => {
    app.store.testing.setJob(jobId, { status: 'succeeded', result: null });
    const response = await call('GET', '/v1/jobs/{jobId}', tokenA);
    expect(response.statusCode).toBe(500);
    expect(json(response.body)?.error.code).toBe('internal_error');
  });

  it('pages the job list and validates the cursor', async () => {
    expect(
      (
        await app.handle(
          event('GET', '/v1/jobs', { token: tokenA, query: { cursor: '../../etc' } }),
        )
      ).statusCode,
    ).toBe(400);
    const list = json((await app.handle(event('GET', '/v1/jobs', { token: tokenA }))).body);
    expect(list?.jobs).toHaveLength(1);
  });

  it('deletes a job', async () => {
    expect((await call('DELETE', '/v1/jobs/{jobId}', tokenA)).statusCode).toBe(204);
    expect((await call('GET', '/v1/jobs/{jobId}', tokenA)).statusCode).toBe(404);
  });
});
