import { loadConfig } from '../lib/config';
import { createMemoryBlobs } from '../lib/blob';
import { createLogger } from '../lib/log';
import { createMemoryStore } from '../lib/store/memory';
import { createExecutors } from './runtime';

const base = { STAGE: 'test', SUPABASE_URL: 'https://project.supabase.co' };
const deps = (env: Record<string, string>) => ({
  config: loadConfig({ ...base, ...env }),
  store: createMemoryStore(),
  blobs: createMemoryBlobs(),
  logger: createLogger('error', () => undefined),
});

describe('createExecutors', () => {
  it('enables no model operation without the pinned guardrail', () => {
    expect(createExecutors(deps({}))).toEqual({});
  });

  it('enables no model operation without a Claude API key', () => {
    expect(createExecutors(deps({ GUARDRAIL_ID: 'gr-1', GUARDRAIL_VERSION: '1' }))).toEqual({});
  });

  it('enables the model operations once the guardrail and the key parameter are configured', () => {
    const executors = createExecutors(
      deps({
        GUARDRAIL_ID: 'gr-1',
        GUARDRAIL_VERSION: '1',
        ANTHROPIC_API_KEY_PARAMETER: '/test/llm/anthropic-api-key',
      }),
    );
    expect(Object.keys(executors)).toEqual([
      'parse_document',
      'analyze_resume',
      'generate_questions',
      'improve_profile',
      'improve_resume',
      'tailor_resume',
    ]);
  });
});
