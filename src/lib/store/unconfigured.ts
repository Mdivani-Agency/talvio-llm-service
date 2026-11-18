import { ApiError } from '../errors';
import type { Store } from './types';

/**
 * The store used when STORE_DRIVER is not set (and for upload grants until MDI-216). Request validation still
 * runs; any call that would read or write state answers 503.
 */
export function createUnconfiguredStore(): Store {
  const unavailable = async (): Promise<never> => {
    throw new ApiError('dependency_unavailable');
  };
  const proxy = <T extends object>() => new Proxy({} as T, { get: () => unavailable });
  return {
    jobs: proxy(),
    outbox: proxy(),
    execution: proxy(),
    documents: proxy(),
    sessions: proxy(),
  };
}
