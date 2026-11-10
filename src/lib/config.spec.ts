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

  describe('dynamodb store', () => {
    const tables = {
      LLM_JOBS_TABLE: 'talvio-llm-jobs-dev',
      LLM_SESSIONS_TABLE: 'talvio-llm-sessions-dev',
      LLM_QUOTAS_TABLE: 'talvio-llm-quotas-dev',
      LLM_OUTBOX_TABLE: 'talvio-llm-outbox-dev',
    };
    const queueUrls = JSON.stringify({ v1: 'https://sqs.us-west-1.amazonaws.com/1/work-v1' });
    const withQueues = { ...base, WORK_QUEUE_URLS: queueUrls };

    it('needs all four Terraform-owned table names', () => {
      expect(loadConfig({ ...withQueues, STORE_DRIVER: 'dynamodb', ...tables })).toMatchObject({
        STORE_DRIVER: 'dynamodb',
        ...tables,
      });
      const { LLM_OUTBOX_TABLE: _omitted, ...three } = tables;
      expect(() => loadConfig({ ...withQueues, STORE_DRIVER: 'dynamodb', ...three })).toThrow(
        new ConfigError(['STORE_DRIVER']),
      );
    });

    it('allows a local DynamoDB endpoint only on local and test stages', () => {
      const env = { ...withQueues, STORE_DRIVER: 'dynamodb', ...tables };
      const endpoint = 'http://localhost:8000';
      expect(() => loadConfig({ ...env, DYNAMODB_ENDPOINT: endpoint })).toThrow(
        new ConfigError(['DYNAMODB_ENDPOINT']),
      );
      expect(
        loadConfig({ ...env, STAGE: 'test', DYNAMODB_ENDPOINT: endpoint }).DYNAMODB_ENDPOINT,
      ).toBe(endpoint);
    });

    it('reads the account-wide daily ceiling', () => {
      expect(loadConfig(base).ACCOUNT_DAILY_CEILING_MICRO_USD).toBe(5_000_000);
      expect(
        loadConfig({ ...base, ACCOUNT_DAILY_CEILING_MICRO_USD: '5000000' })
          .ACCOUNT_DAILY_CEILING_MICRO_USD,
      ).toBe(5_000_000);
    });

    it('needs a work queue URL for the pipeline release', () => {
      const env = { ...base, STORE_DRIVER: 'dynamodb', ...tables };
      const urls = queueUrls;
      expect(() => loadConfig(env)).toThrow(new ConfigError(['WORK_QUEUE_URLS']));
      expect(loadConfig({ ...env, WORK_QUEUE_URLS: urls })).toMatchObject({
        PIPELINE_RELEASE: 'v1',
        WORK_QUEUE_URLS: { v1: 'https://sqs.us-west-1.amazonaws.com/1/work-v1' },
      });
      expect(() => loadConfig({ ...env, WORK_QUEUE_URLS: urls, PIPELINE_RELEASE: 'v2' })).toThrow(
        ConfigError,
      );
      expect(() => loadConfig({ ...env, WORK_QUEUE_URLS: 'not json' })).toThrow(
        new ConfigError(['WORK_QUEUE_URLS']),
      );
    });
  });
});
