import type { SQSEvent } from 'aws-lambda';

import { createWorkerHandler } from './worker/handlers';
import { getRuntime } from './worker/runtime';

/* Lambda entry: SQS work queue, one job per invocation. */

let handler: ReturnType<typeof createWorkerHandler> | undefined;

export const main = (event: SQSEvent) => {
  const runtime = getRuntime();
  handler ??= createWorkerHandler(runtime);
  return handler(event);
};
