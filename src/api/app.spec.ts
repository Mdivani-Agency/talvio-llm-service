import { errorBodySchema } from '@talvio/llm-contracts';

import { createUnconfiguredStore } from '../lib/store/unconfigured';
import { USER_A, event, json, testApp, type TestApp } from '../test/helpers';
import { ROUTE_TABLE } from './route-table';

const SOME_ID = '33333333-3333-4333-8333-333333333333';

const routeEvent = (route: (typeof ROUTE_TABLE)[number], tokenValue?: string) =>
  event(route.method, route.path, {
    params: Object.fromEntries(
      [...route.path.matchAll(/\{(\w+)\}/g)].map((match) => [match[1] as string, SOME_ID]),
    ),
    body: route.method === 'POST' ? {} : undefined,
    token: tokenValue,
  });

describe('authentication on every route', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await testApp();
  });

  const protectedRoutes = ROUTE_TABLE.filter((route) => !('public' in route && route.public));

  it('leaves only health public', () => {
    expect(
      ROUTE_TABLE.filter((route) => 'public' in route && route.public).map((r) => r.id),
    ).toEqual(['health']);
  });

  it.each(protectedRoutes.map((route) => [`${route.method} ${route.path}`, route] as const))(
    '%s refuses a missing token with a safe 401',
    async (_name, route) => {
      const response = await app.handle(routeEvent(route));
      expect(response.statusCode).toBe(401);
      const body = errorBodySchema.parse(json(response.body));
      expect(body.error.code).toBe('unauthorized');
      expect(response.headers?.['X-Correlation-Id']).toBe(body.error.correlationId);
    },
  );

  it.each(protectedRoutes.map((route) => [`${route.method} ${route.path}`, route] as const))(
    '%s refuses an anonymous user',
    async (_name, route) => {
      const anonymous = await app.tokenFor(USER_A, { isAnonymous: true });
      expect((await app.handle(routeEvent(route, anonymous))).statusCode).toBe(401);
    },
  );

  it('refuses a valid token of a deleted account', async () => {
    const { store, handle, tokenFor } = await testApp();
    const valid = await tokenFor(USER_A);
    expect((await handle(event('GET', '/v1/jobs', { token: valid }))).statusCode).toBe(200);
    store.testing.deactivate(USER_A);
    expect((await handle(event('GET', '/v1/jobs', { token: valid }))).statusCode).toBe(401);
  });
});

describe('health', () => {
  it('answers without a token and reveals nothing else', async () => {
    const app = await testApp();
    const response = await app.handle(event('GET', '/v1/health'));
    expect(response.statusCode).toBe(200);
    expect(json(response.body)).toEqual({ status: 'ok' });
  });
});

describe('request handling', () => {
  let app: TestApp;
  let auth: string;
  beforeAll(async () => {
    app = await testApp({ maxBodyBytes: 2_048 });
    auth = await app.tokenFor(USER_A);
  });

  it('answers unknown routes and methods with 404', async () => {
    expect((await app.handle(event('GET', '/v1/admin', { token: auth }))).statusCode).toBe(404);
    expect((await app.handle(event('PUT', '/v1/jobs', { token: auth }))).statusCode).toBe(404);
  });

  it('accepts the resource with or without the llm base path', async () => {
    expect((await app.handle(event('GET', '/llm/v1/health'))).statusCode).toBe(200);
  });

  it('treats non-uuid path ids as missing', async () => {
    const response = await app.handle(
      event('GET', '/v1/jobs/{jobId}', { params: { jobId: "1' or 1=1" }, token: auth }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('rejects malformed JSON without quoting it', async () => {
    const body = '{"text": "Nino Beridze, nino@example.com", oops}';
    const response = await app.handle(
      event('POST', '/v1/sessions', { rawBody: body, token: auth }),
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('nino@example.com');
    expect(app.logs.join('\n')).not.toContain('nino@example.com');
  });

  it('requires a JSON content type', async () => {
    const response = await app.handle(
      event('POST', '/v1/sessions', {
        rawBody: '{}',
        headers: { 'Content-Type': 'text/plain' },
        token: auth,
      }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('rejects bodies over the limit with 413', async () => {
    const response = await app.handle(
      event('POST', '/v1/sessions', { body: { text: 'x'.repeat(4_096) }, token: auth }),
    );
    expect(response.statusCode).toBe(413);
  });

  it('sets no-store and nosniff on every response', async () => {
    const response = await app.handle(event('GET', '/v1/jobs', { token: auth }));
    expect(response.headers).toMatchObject({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': 'application/json',
    });
  });
});

describe('failures stay safe', () => {
  it('turns unexpected errors into a generic 500 and logs only the error name', async () => {
    const app = await testApp();
    const secret = 'provider said: resume of Nino Beridze <nino@example.com>';
    app.store.jobs.list = async () => {
      throw new Error(secret);
    };
    const auth = await app.tokenFor(USER_A);
    const response = await app.handle(event('GET', '/v1/jobs', { token: auth }));
    expect(response.statusCode).toBe(500);
    expect(json(response.body)?.error).toMatchObject({ code: 'internal_error', retryable: true });
    expect(response.body).not.toContain('nino@example.com');
    const logs = app.logs.join('\n');
    expect(logs).not.toContain('nino@example.com');
    expect(logs).toContain('"errorName":"Error"');
  });

  it('never logs tokens, user ids or request content', async () => {
    const app = await testApp();
    const auth = await app.tokenFor(USER_A);
    await app.handle(
      event('POST', '/v1/sessions', {
        body: { clientRequestId: 'session-12345678', purpose: 'improve', note: 'nino@example.com' },
        token: auth,
      }),
    );
    const logs = app.logs.join('\n');
    expect(logs).not.toContain(auth);
    expect(logs).not.toContain(USER_A);
    expect(logs).not.toContain('nino@example.com');
    expect(logs).toContain('"user":');
  });

  it('answers 503 on every protected route until a store is configured', async () => {
    const app = await testApp({ store: createUnconfiguredStore() });
    const auth = await app.tokenFor(USER_A);
    for (const route of ROUTE_TABLE.filter((item) => !('public' in item && item.public))) {
      const response = await app.handle(routeEvent(route, auth));
      expect(response.statusCode).toBe(503);
      expect(json(response.body)?.error.code).toBe('dependency_unavailable');
    }
    expect((await app.handle(event('GET', '/v1/health'))).statusCode).toBe(200);
  });
});
