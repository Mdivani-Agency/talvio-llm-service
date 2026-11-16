describe('Lambda entry', () => {
  const originalEnv = process.env;
  let output: string[];
  let write: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    output = [];
    write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    write.mockRestore();
  });

  const healthEvent = {
    httpMethod: 'GET',
    resource: '/v1/health',
    headers: {},
    requestContext: {},
  };

  it('answers 503 and logs only variable names when configuration is invalid', async () => {
    process.env = { ...originalEnv, STAGE: 'prod', SUPABASE_URL: 'http://secret-host.internal' };
    const { main } = await import('./handler');
    const response = await main(healthEvent as never);
    expect(response.statusCode).toBe(503);
    expect(output.join('')).toContain('"variables":["SUPABASE_URL"]');
    expect(output.join('')).not.toContain('secret-host');
  });

  it('serves health with a valid configuration', async () => {
    process.env = {
      ...originalEnv,
      STAGE: 'test',
      SUPABASE_URL: 'https://project.supabase.example',
      STORE_DRIVER: 'memory',
    };
    const { main } = await import('./handler');
    const response = await main(healthEvent as never);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
  });
});
