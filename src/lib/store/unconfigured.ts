import { ApiError } from '../errors';
import type { Store } from './types';

/**
 * The store used until the Supabase-backed store exists (MDI-214). Authentication and request
 * validation still run; any call that would read or write state answers 503.
 */
export function createUnconfiguredStore(): Store {
  const unavailable = async (): Promise<never> => {
    throw new ApiError('dependency_unavailable');
  };
  const proxy = <T extends object>() => new Proxy({} as T, { get: () => unavailable });
  return {
    accounts: proxy(),
    jobs: proxy(),
    documents: proxy(),
    uploads: proxy(),
    sessions: proxy(),
  };
}
