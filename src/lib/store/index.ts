import type { Config } from '../config';
import { createMemoryStore } from './memory';
import type { Store } from './types';
import { createUnconfiguredStore } from './unconfigured';

export * from './types';

export function createStore(config: Pick<Config, 'STORE_DRIVER'>): Store {
  return config.STORE_DRIVER === 'memory' ? createMemoryStore() : createUnconfiguredStore();
}
