import type { Config } from '../config';
import { createDynamoStore } from './dynamo';
import { createMemoryStore } from './memory';
import type { Store } from './types';
import { createUnconfiguredStore } from './unconfigured';

export * from './types';

type StoreConfig = Pick<
  Config,
  | 'STORE_DRIVER'
  | 'LLM_JOBS_TABLE'
  | 'LLM_SESSIONS_TABLE'
  | 'LLM_QUOTAS_TABLE'
  | 'LLM_OUTBOX_TABLE'
  | 'DYNAMODB_ENDPOINT'
  | 'ACCOUNT_DAILY_CEILING_MICRO_USD'
>;

export function createStore(config: StoreConfig): Store {
  switch (config.STORE_DRIVER) {
    case 'memory':
      return createMemoryStore({
        accountDailyCeilingMicroUsd: config.ACCOUNT_DAILY_CEILING_MICRO_USD,
      });
    case 'dynamodb':
      // Config validation guarantees the table names when this driver is selected.
      return createDynamoStore({
        tables: {
          jobs: config.LLM_JOBS_TABLE ?? '',
          sessions: config.LLM_SESSIONS_TABLE ?? '',
          quotas: config.LLM_QUOTAS_TABLE ?? '',
          outbox: config.LLM_OUTBOX_TABLE ?? '',
        },
        endpoint: config.DYNAMODB_ENDPOINT,
        accountDailyCeilingMicroUsd: config.ACCOUNT_DAILY_CEILING_MICRO_USD,
      });
    default:
      return createUnconfiguredStore();
  }
}
