import { ConfigError, loadConfig } from './config';

const base = { STAGE: 'dev', SUPABASE_URL: 'https://project.supabase.co/' };

describe('loadConfig', () => {
  it('applies defaults and normalizes the Supabase URL', () => {
    expect(loadConfig(base)).toMatchObject({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_JWT_AUDIENCE: 'authenticated',
      SUPABASE_JWT_ALGORITHMS: ['ES256', 'RS256'],
      STORE_DRIVER: 'unconfigured',
      MAX_BODY_BYTES: 1_000_000,
    });
  });

  it('names invalid variables without echoing their values', () => {
    const secretish = 'not-a-url-with-SECRET-123';
    try {
      loadConfig({ STAGE: 'dev', SUPABASE_URL: secretish });
      throw new Error('expected a ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variables).toEqual(['SUPABASE_URL']);
      expect((error as Error).message).not.toContain(secretish);
    }
  });

  it('requires a stage and a Supabase URL', () => {
    expect(() => loadConfig({})).toThrow(new ConfigError(['STAGE', 'SUPABASE_URL']));
  });

  it('never accepts the symmetric HS256 secret mode', () => {
    expect(() => loadConfig({ ...base, SUPABASE_JWT_ALGORITHMS: 'HS256' })).toThrow(ConfigError);
  });

  it('keeps the memory store to local and test stages', () => {
    expect(() => loadConfig({ ...base, STORE_DRIVER: 'memory' })).toThrow(
      new ConfigError(['STORE_DRIVER']),
    );
    expect(loadConfig({ ...base, STAGE: 'local', STORE_DRIVER: 'memory' }).STORE_DRIVER).toBe(
      'memory',
    );
  });

  it('requires https for deployed stages', () => {
    expect(() => loadConfig({ ...base, SUPABASE_URL: 'http://project.supabase.co' })).toThrow(
      new ConfigError(['SUPABASE_URL']),
    );
    expect(() =>
      loadConfig({ STAGE: 'local', SUPABASE_URL: 'http://127.0.0.1:54321' }),
    ).not.toThrow();
  });
});
