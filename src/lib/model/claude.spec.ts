import Anthropic from '@anthropic-ai/sdk';

import {
  classifyClaude,
  createClaudeModel,
  createModelRouter,
  type ClaudeMessages,
} from './claude';
import {
  createScriptedModel,
  ProviderRejectedError,
  ProviderUnavailableError,
  type ModelRequest,
  type ModelResponse,
} from './client';

const request: ModelRequest = {
  modelId: 'claude-haiku-5-5',
  system: 'rules',
  messages: [
    { role: 'user', text: 'resume' },
    { role: 'assistant', toolUseId: 't1', input: { a: 1 } },
    { role: 'tool_result', toolUseId: 't1', text: 'fix it' },
  ],
  tool: { name: 'record_resume', description: 'd', schema: { type: 'object' } },
  maxTokens: 5_000,
  timeoutMs: 1_000,
};

type Call = { body: Record<string, unknown>; options: Record<string, unknown> };

function fake(respond: () => unknown) {
  const calls: Call[] = [];
  const messages = {
    create: async (body: Record<string, unknown>, options: Record<string, unknown>) => {
      calls.push({ body, options });
      return respond();
    },
  } as unknown as ClaudeMessages;
  return { messages, calls };
}

const answer = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  stop_reason: 'tool_use',
  content: [
    { type: 'text', text: 'ignored prose' },
    { type: 'tool_use', id: 'toolu_1', name: 'record_resume', input: { ok: true } },
  ],
  usage: { input_tokens: 10, output_tokens: 20 },
  _request_id: 'req_9',
  ...overrides,
});

const key = async () => 'sk-ant-test';

describe('Claude model client', () => {
  it('pins the single tool, sends no sampling parameters and maps the answer', async () => {
    const { messages, calls } = fake(() => answer());
    const response = await createClaudeModel({ apiKey: key, connect: () => messages }).converse(
      request,
    );
    expect(response).toEqual({
      stopReason: 'tool_use',
      toolUse: { id: 'toolu_1', input: { ok: true } },
      usage: { inputTokens: 10, outputTokens: 20 },
      requestId: 'req_9',
    });
    expect(calls).toHaveLength(1);
    const { body, options } = calls[0]!;
    expect(body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 5_000,
      system: 'rules',
      messages: [
        { role: 'user', content: 'resume' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'record_resume', input: { a: 1 } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'fix it', is_error: true }],
        },
      ],
      tools: [{ name: 'record_resume', description: 'd', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'record_resume', disable_parallel_tool_use: true },
    });
    // One attempt per call: the ledger reserves for each, so the SDK must not retry on its own.
    expect(options).toEqual({ timeout: 1_000, maxRetries: 0 });
  });

  it('reports refusal, truncation, missing usage and a missing tool call as they are', async () => {
    const refusal = fake(() =>
      answer({ stop_reason: 'refusal', content: [], usage: undefined, _request_id: undefined }),
    );
    expect(
      await createClaudeModel({ apiKey: key, connect: () => refusal.messages }).converse(request),
    ).toEqual({ stopReason: 'content_filtered', toolUse: null, usage: null, requestId: null });

    const truncated = fake(() => answer({ stop_reason: 'max_tokens' }));
    const response = await createClaudeModel({
      apiKey: key,
      connect: () => truncated.messages,
    }).converse(request);
    expect(response.stopReason).toBe('max_tokens');

    const paused = fake(() => answer({ stop_reason: 'pause_turn', content: [] }));
    expect(
      (await createClaudeModel({ apiKey: key, connect: () => paused.messages }).converse(request))
        .stopReason,
    ).toBe('other');
  });

  it('counts any cache tokens as input', async () => {
    const { messages } = fake(() =>
      answer({
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 7,
        },
      }),
    );
    const response = await createClaudeModel({ apiKey: key, connect: () => messages }).converse(
      request,
    );
    expect(response.usage).toEqual({ inputTokens: 22, outputTokens: 20 });
  });

  it('classifies failures by type, never by message', () => {
    const headers = new Headers();
    const status = (code: number) => Anthropic.APIError.generate(code, {}, 'secret text', headers);
    expect(classifyClaude(status(429))).toBeInstanceOf(ProviderUnavailableError);
    expect(classifyClaude(status(500))).toBeInstanceOf(ProviderUnavailableError);
    expect(classifyClaude(status(529))).toBeInstanceOf(ProviderUnavailableError);
    expect(classifyClaude(status(408))).toBeInstanceOf(ProviderUnavailableError);
    expect(classifyClaude(new Anthropic.APIConnectionTimeoutError())).toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(classifyClaude(status(400))).toBeInstanceOf(ProviderRejectedError);
    expect(classifyClaude(status(401))).toBeInstanceOf(ProviderRejectedError);
    expect(classifyClaude(status(404))).toBeInstanceOf(ProviderRejectedError);
    expect(classifyClaude(new Error('anything'))).toBeInstanceOf(ProviderUnavailableError);
    expect(classifyClaude(status(400)).message).toBe('provider rejected the request');
  });

  it('turns API failures into classified errors without their text', async () => {
    const { messages } = fake(() => {
      throw Anthropic.APIError.generate(401, {}, 'invalid x-api-key sk-ant-123', new Headers());
    });
    const error = await createClaudeModel({ apiKey: key, connect: () => messages })
      .converse(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect(String((error as Error).message)).not.toContain('sk-ant');
  });

  it('reads the key once, and again after a failed read', async () => {
    let reads = 0;
    const apiKey = async () => {
      reads += 1;
      if (reads === 1) throw new Error('ssm down');
      return 'sk-ant-test';
    };
    const connected: string[] = [];
    const { messages, calls } = fake(() => answer());
    const model = createClaudeModel({
      apiKey,
      connect: (value) => {
        connected.push(value);
        return messages;
      },
    });
    // The first read fails: a retryable failure, with no request sent.
    await expect(model.converse(request)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(calls).toHaveLength(0);
    await model.converse(request);
    await model.converse(request);
    expect(reads).toBe(2);
    expect(connected).toEqual(['sk-ant-test']);
    expect(calls).toHaveLength(2);
  });
});

describe('model router', () => {
  const reply: ModelResponse = {
    stopReason: 'end_turn',
    toolUse: null,
    usage: null,
    requestId: null,
  };

  it('sends Claude model ids to the Claude API and everything else to Bedrock', async () => {
    const claude = createScriptedModel([reply]);
    const bedrock = createScriptedModel([reply]);
    const router = createModelRouter({ claude, bedrock });
    await router.converse(request);
    await router.converse({ ...request, modelId: 'us.amazon.nova-2-lite-v1:0' });
    expect(claude.requests.map((r) => r.modelId)).toEqual(['claude-haiku-5-5']);
    expect(bedrock.requests.map((r) => r.modelId)).toEqual(['us.amazon.nova-2-lite-v1:0']);
  });
});
