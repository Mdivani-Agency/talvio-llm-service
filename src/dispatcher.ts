import { createDispatcher } from './worker/handlers';
import { getRuntime } from './worker/runtime';

/* Lambda entry: scheduled outbox dispatcher. */

let handler: ReturnType<typeof createDispatcher> | undefined;

export const main = () => {
  const runtime = getRuntime();
  handler ??= createDispatcher(runtime);
  return handler();
};
