import { ApiError } from '../errors';
import type { Store } from './types';

/**
 * The store used until the DynamoDB-backed store exists (MDI-214). Request validation still
 * runs; any call that would read or write state answers 503.
 */
export function createUnconfiguredStore(): Store {
  const unavailable = async (): Promise<never> => {
    throw new ApiError('dependency_unavailable');
  };
  const proxy = <T extends object>() => new Proxy({} as T, { get: () => unavailable });
  return {
    jobs: proxy(),
    documents: proxy(),
    uploads: proxy(),
    sessions: proxy(),
  };
}
