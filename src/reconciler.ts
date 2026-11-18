import { createReconciler } from './worker/handlers';
import { getRuntime } from './worker/runtime';

/* Lambda entry: scheduled reconciler (deadlines, expired leases, lost sends). */

let handler: ReturnType<typeof createReconciler> | undefined;

export const main = () => {
  const runtime = getRuntime();
  handler ??= createReconciler(runtime);
  return handler();
};
