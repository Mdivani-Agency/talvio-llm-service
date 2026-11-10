import { loadConfig, type Config } from '../lib/config';
import { createBlobs, type BlobStore } from '../lib/blob';
import { createTextractClient } from '../lib/ocr';
import { createLogger, type Logger } from '../lib/log';
import { createNoQueues, createSqsQueues, type WorkQueues } from '../lib/queue';
import { createStore, type Store } from '../lib/store';
import type { OcrConfig } from './ocr';
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
 * Executors by operation for this pipeline release. Each operation's executor arrives with its own
 * ticket (extraction and OCR, safeguard, inference, validation); until then a claimed job fails at
 * once with a retryable `dependency_unavailable` instead of waiting out its deadline.
 */
export const EXECUTORS: Executors = {};

let cached: Runtime | undefined;

/** The container's runtime, built on first use. */
export function getRuntime(): Runtime {
  cached ??= createRuntime();
  return cached;
}

export function createRuntime(): Runtime {
  const config = loadConfig();
  return {
    config,
    store: createStore(config),
    blobs: createBlobs(config),
    currentRelease: config.PIPELINE_RELEASE,
    queues: config.WORK_QUEUE_URLS ? createSqsQueues(config.WORK_QUEUE_URLS) : createNoQueues(),
    logger: createLogger(config.LOG_LEVEL),
    executors: EXECUTORS,
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
