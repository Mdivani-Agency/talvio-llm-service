import type { SQSEvent } from 'aws-lambda';

import { createOcrHandler } from './worker/handlers';
import { getRuntime } from './worker/runtime';

/* Lambda entry: Textract completion notifications (SNS to the OCR queue). */

let handler: ReturnType<typeof createOcrHandler> | undefined;

export const main = (event: SQSEvent) => {
  const runtime = getRuntime();
  handler ??= createOcrHandler(runtime);
  return handler(event);
};
