import { createMemoryStore } from './memory';
import { describeStoreContract } from './store.contract';

describeStoreContract('memory', async (options) => {
  const store = createMemoryStore(options);
  return {
    store,
    async setLimitOverride(ownerId, override) {
      store.testing.setLimitOverride(ownerId, override);
    },
    async failJob(ownerId, jobId) {
      const job = await store.jobs.get(ownerId, jobId);
      store.testing.setJob(jobId, {
        status: 'failed',
        stage: 'done',
        spendReservedMicroUsd: 0,
        error: { code: 'internal_error', message: 'x', retryable: true } as never,
        updatedAt: job?.updatedAt,
      });
    },
  };
});
