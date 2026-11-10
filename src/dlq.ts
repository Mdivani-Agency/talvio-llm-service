import type { SQSEvent } from 'aws-lambda';

import { createDeadLetterHandler } from './worker/handlers';
import { getRuntime } from './worker/runtime';

/* Lambda entry: the work queue's dead-letter queue. */

let handler: ReturnType<typeof createDeadLetterHandler> | undefined;

export const main = (event: SQSEvent) => {
  const runtime = getRuntime();
  handler ??= createDeadLetterHandler(runtime);
  return handler(event);
};
