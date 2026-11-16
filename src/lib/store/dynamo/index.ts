import type { Store } from '../types';
import { createDb, type Tables } from './db';
import { createDynamoDocumentStore } from './documents';
import { createDynamoJobStore, type DynamoJobStoreOptions } from './jobs';
import { createDynamoExecutionStore } from './execution';
import { createDynamoOutboxStore } from './outbox';
import { createDynamoSessionStore } from './sessions';

export type DynamoStoreOptions = DynamoJobStoreOptions & {
  tables: Tables;
  region?: string;
  endpoint?: string;
};

export type DynamoStore = Store & { jobs: ReturnType<typeof createDynamoJobStore> };

/** The DynamoDB-backed store used on deployed stages. Upload grants arrive with MDI-216. */
export function createDynamoStore(options: DynamoStoreOptions): DynamoStore {
  const db = createDb(options);
  return {
    jobs: createDynamoJobStore(db, options),
    outbox: createDynamoOutboxStore(db),
    execution: createDynamoExecutionStore(db),
    documents: createDynamoDocumentStore(db),
    sessions: createDynamoSessionStore(db),
  };
}

export { createDb, type Db, type Tables } from './db';
