import { loadConfig } from '../config';
import { createLogger } from '../log';
import { SecretUnavailableError } from '../secrets';
import { ProviderUnavailableError, type ModelRequest } from './client';
import { createModelDeps } from './providers';

const base = { STAGE: 'test', SUPABASE_URL: 'https://project.supabase.co' };
const guarded = { ...base, GUARDRAIL_ID: 'gr-1', GUARDRAIL_VERSION: '1' };

const request: ModelRequest = {
  modelId: 'claude-haiku-5-5',
  system: 's',
  messages: [{ role: 'user', text: 'resume text' }],
  tool: { name: 't', description: 'd', schema: { type: 'object' } },
  maxTokens: 10,
  timeoutMs: 1_000,
};

describe('createModelDeps', () => {
  it('needs both the guardrail and a key source', () => {
    expect(createModelDeps(loadConfig(base))).toBeNull();
    expect(createModelDeps(loadConfig(guarded))).toBeNull();
    expect(
      createModelDeps(
        loadConfig({ ...guarded, ANTHROPIC_API_KEY_PARAMETER: '/test/llm/anthropic-api-key' }),
      ),
    ).not.toBeNull();
    expect(
      createModelDeps(loadConfig({ ...guarded, ANTHROPIC_API_KEY: 'sk-ant-1' })),
    ).not.toBeNull();
  });

  it('logs a failed key read by error name only and fails the call as retryable', async () => {
    const lines: string[] = [];
    const deps = createModelDeps(loadConfig(guarded), {
      logger: createLogger('info', (line) => lines.push(line)),
      apiKey: async () => {
        throw new SecretUnavailableError();
      },
    })!;
    await expect(deps.model.converse(request)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: 'secret_unavailable', errorName: 'SecretUnavailableError' }),
    ]);
    expect(lines.join('\n')).not.toContain('resume text');
  });
});
