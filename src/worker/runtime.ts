import { loadConfig, type Config } from '../lib/config';
import { createBlobs, type BlobStore } from '../lib/blob';
import { createTextractClient } from '../lib/ocr';
import { createLogger, type Logger } from '../lib/log';
import { createNoQueues, createSqsQueues, type WorkQueues } from '../lib/queue';
import { createStore, type Store } from '../lib/store';
import { createBedrockGuardrail, createBedrockModel } from '../lib/model/client';
import type { OcrConfig } from './ocr';
import { createAnalyzeExecutor } from './analyze';
import { createImproveExecutor } from './improve';
import { createParseExecutor } from './parse';
import { createQuestionsExecutor } from './questions';
import type { Executors } from './run';

/*
 * What the background Lambdas share: validated configuration, the store, the queues and the
 * executors of this release. Built once per container. An invalid configuration throws, so every
 * invocation fails visibly (SQS redelivers; scheduled runs show as errors) and nothing runs
 * against a half-configured store.
 */

export type Runtime = {
  config: Config;
  store: Store;
  blobs: BlobStore;
  /** Release new work is pinned to; document work always goes to its queue. */
  currentRelease: string;
  queues: WorkQueues;
  logger: Logger;
  executors: Executors;
  /** Set only when some content type is read by OCR; otherwise nothing reaches Textract. */
  ocr?: OcrConfig;
};

/**
 * Executors by operation for this pipeline release. An operation without one (not built yet, or
 * its guardrail is not configured) fails at once with a retryable `dependency_unavailable` instead
 * of waiting out its deadline.
 */
export function createExecutors(deps: {
  config: Config;
  store: Store;
  blobs: BlobStore;
  logger: Logger;
}): Executors {
  const { config } = deps;
  if (!config.GUARDRAIL_ID || !config.GUARDRAIL_VERSION) return {};
  const model = createBedrockModel(config.BEDROCK_REGION);
  const guardrail = createBedrockGuardrail(
    config.BEDROCK_REGION,
    config.GUARDRAIL_ID,
    config.GUARDRAIL_VERSION,
  );
  const modelDeps = { ...deps, model, guardrail };
  return {
    parse_document: createParseExecutor(modelDeps),
    analyze_resume: createAnalyzeExecutor(modelDeps),
    generate_questions: createQuestionsExecutor(modelDeps),
    improve_profile: createImproveExecutor(modelDeps, 'improve_profile'),
    improve_resume: createImproveExecutor(modelDeps, 'improve_resume'),
  };
}

let cached: Runtime | undefined;

/** The container's runtime, built on first use. */
export function getRuntime(): Runtime {
  cached ??= createRuntime();
  return cached;
}

export function createRuntime(): Runtime {
  const config = loadConfig();
  const store = createStore(config);
  const blobs = createBlobs(config);
  const logger = createLogger(config.LOG_LEVEL);
  return {
    config,
    store,
    blobs,
    currentRelease: config.PIPELINE_RELEASE,
    queues: config.WORK_QUEUE_URLS ? createSqsQueues(config.WORK_QUEUE_URLS) : createNoQueues(),
    logger,
    executors: createExecutors({ config, store, blobs, logger }),
    ocr:
      config.OCR_CONTENT_TYPES.length > 0 &&
      config.OCR_TOPIC_ARN &&
      config.OCR_ROLE_ARN &&
      config.LLM_QUARANTINE_BUCKET
        ? {
            client: createTextractClient(),
            topicArn: config.OCR_TOPIC_ARN,
            roleArn: config.OCR_ROLE_ARN,
            bucket: config.LLM_QUARANTINE_BUCKET,
            types: config.OCR_CONTENT_TYPES,
          }
        : undefined,
  };
}
