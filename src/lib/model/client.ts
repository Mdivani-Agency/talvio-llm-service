import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';

/*
 * Provider boundary (design §9, §10). Operations talk to a ModelClient and a Guardrail, never to
 * the SDK: the Bedrock implementations below are the only code that knows request shapes. A call
 * is made once per attempt; the SDK's own retries are off, because every application attempt has
 * its own spend reservation and an ambiguous failure must be counted as possibly charged.
 *
 * The model gets exactly one tool, and tool choice is pinned to it: the tool is an output
 * envelope, not something that runs. Nothing here fetches URLs or executes anything the model
 * asks for.
 */

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema the model's tool input is asked to follow; validated again locally. */
  schema: Record<string, unknown>;
};

export type ModelRequest = {
  modelId: string;
  system: string;
  /** Alternating turns, user first. Repairs append the model's previous tool use and a note. */
  messages: ModelMessage[];
  tool: ToolSpec;
  maxTokens: number;
  timeoutMs: number;
};

export type ModelMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; toolUseId: string; input: unknown }
  | { role: 'tool_result'; toolUseId: string; text: string };

export type StopReason =
  | 'tool_use'
  | 'end_turn'
  | 'max_tokens'
  | 'content_filtered'
  | 'guardrail_intervened'
  | 'other';

export type ModelResponse = {
  stopReason: StopReason;
  /** The pinned tool's input, when the model called it. */
  toolUse: { id: string; input: unknown } | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  requestId: string | null;
};

export interface ModelClient {
  converse(request: ModelRequest): Promise<ModelResponse>;
}

export type GuardrailResult = {
  intervened: boolean;
  /** Content-policy text units the call was billed for, when reported. */
  units: number | null;
};

export interface Guardrail {
  readonly id: string;
  readonly version: string;
  /** Checks untrusted input text (source INPUT) against the pinned policy version. */
  check(text: string, timeoutMs: number): Promise<GuardrailResult>;
}

/** The provider did not answer usably: throttled, unavailable, timed out. Retry within budget. */
export class ProviderUnavailableError extends Error {
  constructor() {
    super('provider unavailable');
    this.name = 'ProviderUnavailableError';
  }
}

/** The provider refused the request itself (access, validation, missing model): not retryable. */
export class ProviderRejectedError extends Error {
  constructor() {
    super('provider rejected the request');
    this.name = 'ProviderRejectedError';
  }
}

const TRANSIENT = new Set([
  'ThrottlingException',
  'ServiceUnavailableException',
  'InternalServerException',
  'ModelNotReadyException',
  'ModelTimeoutException',
  'ModelErrorException',
  'AbortError',
  'TimeoutError',
]);

/** Maps an SDK failure to a class; only its name is looked at, never its message. */
export function classify(error: unknown): Error {
  const name = (error as { name?: string })?.name ?? '';
  const fault = (error as { $fault?: string })?.$fault;
  return TRANSIENT.has(name) || fault === 'server' || name === ''
    ? new ProviderUnavailableError()
    : new ProviderRejectedError();
}

function toBedrock(messages: ModelMessage[], toolName: string): Message[] {
  return messages.map((message): Message => {
    switch (message.role) {
      case 'user':
        return { role: 'user', content: [{ text: message.text }] };
      case 'assistant':
        return {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: message.toolUseId,
                name: toolName,
                input: message.input as never,
              },
            },
          ],
        };
      case 'tool_result':
        return {
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: message.toolUseId,
                content: [{ text: message.text }],
                status: 'error',
              },
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
  content_filtered: 'content_filtered',
  guardrail_intervened: 'guardrail_intervened',
};

export function createBedrockModel(region: string, client?: BedrockRuntimeClient): ModelClient {
  const bedrock = client ?? new BedrockRuntimeClient({ region, maxAttempts: 1 });
  return {
    async converse(request) {
      const messages = toBedrock(request.messages, request.tool.name);
      let out;
      try {
        out = await bedrock.send(
          new ConverseCommand({
            modelId: request.modelId,
            system: [{ text: request.system }],
            messages,
            toolConfig: {
              tools: [
                {
                  toolSpec: {
                    name: request.tool.name,
                    description: request.tool.description,
                    inputSchema: { json: request.tool.schema as never },
                  },
                },
              ],
              toolChoice: { tool: { name: request.tool.name } },
            },
            inferenceConfig: { maxTokens: request.maxTokens, temperature: 0 },
          }),
          { abortSignal: AbortSignal.timeout(request.timeoutMs) },
        );
      } catch (error) {
        throw classify(error);
      }
      const block = out.output?.message?.content?.find(
        (item) => item.toolUse?.name === request.tool.name,
      );
      const usage = out.usage;
      return {
        stopReason: STOP[out.stopReason ?? ''] ?? 'other',
        toolUse: block?.toolUse
          ? { id: block.toolUse.toolUseId ?? 'tool-1', input: block.toolUse.input ?? null }
          : null,
        usage:
          usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
            ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
            : null,
        requestId: out.$metadata.requestId ?? null,
      };
    },
  };
}

export function createBedrockGuardrail(
  region: string,
  id: string,
  version: string,
  client?: BedrockRuntimeClient,
): Guardrail {
  const bedrock = client ?? new BedrockRuntimeClient({ region, maxAttempts: 1 });
  return {
    id,
    version,
    async check(text, timeoutMs) {
      let out;
      try {
        out = await bedrock.send(
          new ApplyGuardrailCommand({
            guardrailIdentifier: id,
            guardrailVersion: version,
            source: 'INPUT',
            content: [{ text: { text } }],
          }),
          { abortSignal: AbortSignal.timeout(timeoutMs) },
        );
      } catch (error) {
        throw classify(error);
      }
      return {
        intervened: out.action === 'GUARDRAIL_INTERVENED',
        units: out.usage?.contentPolicyUnits ?? null,
      };
    },
  };
}

/** Scripted clients for tests and local runs: each call takes the next response in order. */
export function createScriptedModel(
  responses: (ModelResponse | Error)[] = [],
): ModelClient & { requests: ModelRequest[]; responses: (ModelResponse | Error)[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    responses,
    async converse(request) {
      requests.push(request);
      const next = responses.shift();
      if (!next) throw new ProviderUnavailableError();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

export function createScriptedGuardrail(
  results: (GuardrailResult | Error)[] = [],
): Guardrail & { checked: string[]; results: (GuardrailResult | Error)[] } {
  const checked: string[] = [];
  return {
    id: 'test-guardrail',
    version: '1',
    checked,
    results,
    async check(text) {
      checked.push(text);
      const next = results.shift() ?? { intervened: false, units: null };
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
