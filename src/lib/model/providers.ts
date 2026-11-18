import type { Config } from '../config';
import type { Logger } from '../log';
import { ssmSecret } from '../secrets';
import { createModelRouter, createClaudeModel, type ApiKeySource } from './claude';
import {
  createBedrockGuardrail,
  createBedrockModel,
  type Guardrail,
  type ModelClient,
} from './client';

/*
 * The model and guardrail a worker uses, from configuration (MDI-638). Claude models are called
 * through the Claude API with the key from SSM (or, on local and test stages, ANTHROPIC_API_KEY);
 * other model ids, and the input guardrail, stay on Bedrock. Null when either half is missing:
 * no model is ever called without the guardrail. A failed key read is logged as
 * `secret_unavailable` (error name only) and the call fails as retryable.
 */
export function createModelDeps(
  config: Config,
  options: { logger?: Logger; apiKey?: ApiKeySource } = {},
): { model: ModelClient; guardrail: Guardrail } | null {
  if (!config.GUARDRAIL_ID || !config.GUARDRAIL_VERSION) return null;
  const localKey = config.ANTHROPIC_API_KEY;
  const source =
    options.apiKey ??
    (localKey
      ? async () => localKey
      : config.ANTHROPIC_API_KEY_PARAMETER
        ? ssmSecret(config.ANTHROPIC_API_KEY_PARAMETER)
        : undefined);
  if (!source) return null;
  const apiKey: ApiKeySource = async () => {
    try {
      return await source();
    } catch (error) {
      options.logger?.log('error', {
        event: 'secret_unavailable',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      throw error;
    }
  };
  return {
    model: createModelRouter({
      claude: createClaudeModel({ apiKey }),
      bedrock: createBedrockModel(config.BEDROCK_REGION),
    }),
    guardrail: createBedrockGuardrail(
      config.BEDROCK_REGION,
      config.GUARDRAIL_ID,
      config.GUARDRAIL_VERSION,
    ),
  };
}
