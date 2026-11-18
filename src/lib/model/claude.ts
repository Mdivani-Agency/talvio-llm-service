import Anthropic from '@anthropic-ai/sdk';

import {
  ProviderRejectedError,
  ProviderUnavailableError,
  type ModelClient,
  type ModelMessage,
  type StopReason,
} from './client';

/*
 * Claude API implementation of the provider boundary (MDI-638). Same contract as the Bedrock
 * client: one call per attempt with the SDK's retries off, exactly one tool with tool choice pinned
 * to it, and failures classified by type only, never by message.
 *
 * A forced tool call starts with the tool use and carries no thinking block, so a repair turn can
 * replay the model's previous tool use as it is. No sampling parameters are sent (current Haiku
 * rejects them); the schema and local validation constrain the output instead.
 *
 * The API key is read through `apiKey` on first use and kept for the container's life; a failed
 * read is retried on the next call. It never reaches a log, an error or the environment.
 */

export type ApiKeySource = () => Promise<string>;

export function classifyClaude(error: unknown): Error {
  if (
    error instanceof Anthropic.APIConnectionError || // includes timeouts and aborts
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError || // 5xx, including 529 overloaded
    error instanceof Anthropic.RequestTimeoutError
  )
    return new ProviderUnavailableError();
  if (error instanceof Anthropic.APIError)
    // Status, the error's type or stable code, and the request id: never its message.
    return new ProviderRejectedError({
      status: error.status,
      code: error.errorCode ?? error.type ?? undefined,
      requestId: error.requestID ?? undefined,
    });
  // Not from the API (key lookup, network stack): transient as far as this call can tell.
  return new ProviderUnavailableError();
}

function toClaude(messages: ModelMessage[], toolName: string): Anthropic.MessageParam[] {
  return messages.map((message): Anthropic.MessageParam => {
    switch (message.role) {
      case 'user':
        return { role: 'user', content: message.text };
      case 'assistant':
        return {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: message.toolUseId, name: toolName, input: message.input },
          ],
        };
      case 'tool_result':
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolUseId,
              content: message.text,
              is_error: true,
            },
          ],
        };
    }
  });
}

const STOP: Record<string, StopReason> = {
  tool_use: 'tool_use',
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens',
  refusal: 'content_filtered',
};

/** Only what the adapter calls; lets tests stand in for the SDK. */
export type ClaudeMessages = Pick<Anthropic['messages'], 'create'>;

const connectSdk = (apiKey: string): ClaudeMessages =>
  new Anthropic({ apiKey, maxRetries: 0, logLevel: 'off' }).messages;

export function createClaudeModel(deps: {
  apiKey: ApiKeySource;
  /** Test seam: builds the messages API from the key (the SDK by default). */
  connect?: (apiKey: string) => ClaudeMessages;
}): ModelClient {
  const connect = deps.connect ?? connectSdk;
  let client: Promise<ClaudeMessages> | undefined;
  const messagesApi = () => {
    client ??= deps.apiKey().then(connect);
    // A failed key read is not cached: the next attempt reads again.
    client.catch(() => (client = undefined));
    return client;
  };

  return {
    async converse(request) {
      let out: Anthropic.Message & { _request_id?: string | null };
      try {
        const api = await messagesApi();
        out = await api.create(
          {
            model: request.modelId,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: toClaude(request.messages, request.tool.name),
            tools: [
              {
                name: request.tool.name,
                description: request.tool.description,
                input_schema: request.tool.schema as Anthropic.Tool.InputSchema,
              },
            ],
            tool_choice: { type: 'tool', name: request.tool.name, disable_parallel_tool_use: true },
          },
          { timeout: request.timeoutMs, maxRetries: 0 },
        );
      } catch (error) {
        throw classifyClaude(error);
      }
      const block = out.content.find(
        (item): item is Anthropic.ToolUseBlock =>
          item.type === 'tool_use' && item.name === request.tool.name,
      );
      const usage = out.usage;
      return {
        stopReason: STOP[out.stop_reason ?? ''] ?? 'other',
        toolUse: block ? { id: block.id, input: block.input ?? null } : null,
        usage:
          usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
            ? {
                // Cache tokens are billed as input too; nothing here caches, but count them if present.
                inputTokens:
                  usage.input_tokens +
                  (usage.cache_creation_input_tokens ?? 0) +
                  (usage.cache_read_input_tokens ?? 0),
                outputTokens: usage.output_tokens,
              }
            : null,
        requestId: out._request_id ?? null,
      };
    },
  };
}

/** Routes each call by model id: `claude-*` to the Claude API, everything else to Bedrock. */
export function createModelRouter(models: {
  claude: ModelClient;
  bedrock: ModelClient;
}): ModelClient {
  return {
    converse: (request) =>
      (request.modelId.startsWith('claude-') ? models.claude : models.bedrock).converse(request),
  };
}
