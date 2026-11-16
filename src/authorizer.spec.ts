describe('authorizer Lambda entry', () => {
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

  const tokenEvent = {
    type: 'TOKEN' as const,
    authorizationToken: 'Bearer not-a-jwt',
    methodArn: 'arn:aws:execute-api:us-west-1:000000000000:abc123/dev/GET/v1/jobs',
  };

  it('fails every request and logs only variable names when configuration is invalid', async () => {
    process.env = { ...originalEnv, STAGE: 'prod', SUPABASE_URL: 'http://secret-host.internal' };
    const { main } = await import('./authorizer');
    await expect(main(tokenEvent)).rejects.toThrow('Authorizer unavailable');
    expect(output.join('')).toContain('"variables":["SUPABASE_URL"]');
    expect(output.join('')).not.toContain('secret-host');
  });

  it('answers Unauthorized for a bad token with a valid configuration', async () => {
    process.env = {
      ...originalEnv,
      STAGE: 'test',
      SUPABASE_URL: 'https://project.supabase.example',
    };
    const { main } = await import('./authorizer');
    await expect(main(tokenEvent)).rejects.toThrow('Unauthorized');
  });
});
