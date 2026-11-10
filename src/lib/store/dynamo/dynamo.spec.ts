import { randomUUID } from 'crypto';

import {
  CreateTableCommand,
  DeleteTableCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { describeStoreContract } from '../store.contract';
import { createDb, epochSeconds, utcDay, type Db, type Tables } from './db';
import { createDynamoStore } from './index';
import { createDynamoJobStore } from './jobs';
import { limitsKey, releaseQuota } from './quota';
import { transact } from './db';

/*
 * Runs against DynamoDB Local (CI starts it as a service container; locally set
 * TEST_DYNAMODB_ENDPOINT=http://localhost:8000). Skipped when no endpoint is set, so `yarn test` works
 * offline and the memory store keeps covering the unit level.
 */
const endpoint = process.env.TEST_DYNAMODB_ENDPOINT;
const suite = endpoint ? describe : describe.skip;

const SHAPE = {
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'sk', AttributeType: 'S' },
    { AttributeName: 'gsi1pk', AttributeType: 'S' },
    { AttributeName: 'gsi1sk', AttributeType: 'S' },
  ],
  KeySchema: [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'sk', KeyType: 'RANGE' },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: 'GSI1',
      KeySchema: [
        { AttributeName: 'gsi1pk', KeyType: 'HASH' },
        { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    },
  ],
  BillingMode: 'PAY_PER_REQUEST',
} as const;

suite('DynamoDB', () => {
  const run = randomUUID().slice(0, 8);
  const tables: Tables = {
    jobs: `llm-jobs-${run}`,
    sessions: `llm-sessions-${run}`,
    quotas: `llm-quotas-${run}`,
    outbox: `llm-outbox-${run}`,
  };
  const db: Db = createDb({ tables, endpoint });

  beforeAll(async () => {
    for (const TableName of Object.values(tables)) {
      await db.client.send(new CreateTableCommand({ TableName, ...SHAPE } as never));
      // DynamoDB Local ignores TTL but accepts the call, matching the Terraform tables.
      await db.client.send(
        new UpdateTimeToLiveCommand({
          TableName,
          TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        }),
      );
    }
  });

  afterAll(async () => {
    for (const TableName of Object.values(tables)) {
      await db.client.send(new DeleteTableCommand({ TableName }));
    }
  });

  // Every test gets fresh users, so tables are shared and never need clearing.
  describeStoreContract('DynamoDB', async (options) => {
    const store = createDynamoStore({ tables, endpoint, ...options });
    return {
      store,
      async setLimitOverride(ownerId, override) {
        await db.client.send(
          new PutCommand({
            TableName: tables.quotas,
            Item: { ...limitsKey(ownerId), ...override },
          }),
        );
      },
      async failJob(ownerId, jobId) {
        const job = await store.jobs.get(ownerId, jobId);
        if (!job) throw new Error('no such job');
        await transact(db, [
          {
            Update: {
              TableName: tables.jobs,
              Key: { pk: `U#${ownerId}`, sk: `JOB#${jobId}` },
              UpdateExpression:
                'SET #status = :failed, #stage = :done, spendReservedMicroUsd = :zero',
              ExpressionAttributeNames: { '#status': 'status', '#stage': 'stage' },
              ExpressionAttributeValues: { ':failed': 'failed', ':done': 'done', ':zero': 0 },
            },
          },
          ...releaseQuota(db, ownerId, job, utcDay(job.createdAt)),
        ]);
        await db.client.send(
          new UpdateCommand({
            TableName: tables.jobs,
            Key: { pk: `U#${ownerId}`, sk: `JOB#${jobId}` },
            UpdateExpression: 'SET #error = :error',
            ExpressionAttributeNames: { '#error': 'error' },
            ExpressionAttributeValues: {
              ':error': { code: 'internal_error', message: 'x', retryable: true },
            },
          }),
        );
      },
    };
  });

  describe('retention', () => {
    let owner = randomUUID();
    beforeEach(() => {
      owner = randomUUID();
    });
    const long = new Date('2026-01-01T00:00:00.000Z');

    it('treats items past their TTL as gone before the sweeper removes them', async () => {
      const store = createDynamoStore({ tables, endpoint });
      const { job } = await store.jobs.admit({
        ownerId: owner,
        plan: 'free',
        idempotencyKey: 'key-expired-1',
        requestHash: 'h',
        request: {
          operation: 'parse_document',
          input: { kind: 'text', text: 't', extraction: null },
        } as never,
        now: long,
        deadlineAt: new Date(long.getTime() + 600_000),
      });
      expect(job.jobId).toBeDefined();
      expect(await store.jobs.get(owner, job.jobId)).toBeNull();
      expect(await store.jobs.findByIdempotencyKey(owner, 'key-expired-1')).toBeNull();
      expect((await store.jobs.list(owner, null, 10)).jobs).toEqual([]);

      const document = await store.documents.create(
        owner,
        { contentType: 'application/pdf', sizeBytes: 1, sha256: 'a'.repeat(64) } as never,
        long,
      );
      expect(await store.documents.get(owner, document.documentId)).toBeNull();
      expect(await store.documents.complete(owner, document.documentId, new Date())).toBeNull();
    });

    it('writes every item with a TTL on the documented schedule', async () => {
      const jobs = createDynamoJobStore(db);
      const now = new Date();
      const { job } = await jobs.admit({
        ownerId: owner,
        plan: 'free',
        idempotencyKey: 'key-ttl-0001',
        requestHash: 'h',
        request: {
          operation: 'parse_document',
          input: { kind: 'text', text: 't', extraction: null },
        } as never,
        now,
        deadlineAt: new Date(now.getTime() + 600_000),
      });
      await jobs.putResult(owner, job.jobId, { ok: true }, now);
      const read = async (table: string, sk: string) =>
        (
          await db.client.send(
            new (await import('@aws-sdk/lib-dynamodb')).GetCommand({
              TableName: table,
              Key: { pk: `U#${owner}`, sk },
            }),
          )
        ).Item;
      const day = 24 * 60 * 60;
      const at = epochSeconds(now);
      expect((await read(tables.jobs, `JOB#${job.jobId}`))?.expiresAt).toBe(at + 30 * day);
      expect((await read(tables.jobs, `IDEM#key-ttl-0001`))?.expiresAt).toBe(at + 30 * day);
      expect((await read(tables.jobs, `RESULT#${job.jobId}`))?.expiresAt).toBe(at + 7 * day);
      const bucket = await read(tables.quotas, `DAY#${utcDay(now)}`);
      expect(bucket?.expiresAt).toBeGreaterThan(at);
    });

    it('returns a published result with a succeeded job', async () => {
      const jobs = createDynamoJobStore(db);
      const now = new Date();
      const { job } = await jobs.admit({
        ownerId: owner,
        plan: 'free',
        idempotencyKey: 'key-result-01',
        requestHash: 'h',
        request: {
          operation: 'parse_document',
          input: { kind: 'text', text: 't', extraction: null },
        } as never,
        now,
        deadlineAt: new Date(now.getTime() + 600_000),
      });
      await jobs.putResult(owner, job.jobId, { answer: 42 }, now);
      await db.client.send(
        new UpdateCommand({
          TableName: tables.jobs,
          Key: { pk: `U#${owner}`, sk: `JOB#${job.jobId}` },
          UpdateExpression: 'SET #status = :s',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':s': 'succeeded' },
        }),
      );
      expect((await jobs.get(owner, job.jobId))?.result).toEqual({ answer: 42 });
      expect(
        (await jobs.list(owner, null, 10)).jobs.find((j) => j.jobId === job.jobId)?.result,
      ).toEqual({
        answer: 42,
      });
      expect(await jobs.get(randomUUID(), job.jobId)).toBeNull();
    });
  });
});
