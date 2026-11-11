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
import { limitsKey, settleQuota } from './quota';
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
    const store = createDynamoStore({
      tables,
      endpoint,
      // The account counter is shared by every test on the shared table and day.
      accountDailyCeilingMicroUsd: 1_000_000_000,
      ...options,
    });
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
          ...settleQuota(db, ownerId, job, job.spendCommittedMicroUsd, utcDay(job.createdAt)),
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
        pipelineReleaseId: 'v1',
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
        'pending/o/k',
        long,
      );
      expect(await store.documents.get(owner, document.documentId)).toBeNull();
      expect(
        await store.documents.complete(owner, document.documentId, { versionId: null }, new Date()),
      ).toBeNull();
    });

    const parse = {
      operation: 'parse_document',
      input: { kind: 'text', text: 't', extraction: null },
    } as never;
    const admitAt = (store: ReturnType<typeof createDynamoStore>, key: string, now: Date) =>
      store.jobs.admit({
        ownerId: owner,
        plan: 'free',
        pipelineReleaseId: 'v1',
        idempotencyKey: key,
        requestHash: key,
        request: parse,
        now,
        deadlineAt: new Date(now.getTime() + 600_000),
      });
    const markSucceeded = (jobId: string) =>
      db.client.send(
        new UpdateCommand({
          TableName: tables.jobs,
          Key: { pk: `U#${owner}`, sk: `JOB#${jobId}` },
          UpdateExpression: 'SET #status = :s',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':s': 'succeeded' },
        }),
      );

    it('lets a request reuse an idempotency key whose record has expired but is not yet swept', async () => {
      const store = createDynamoStore({ tables, endpoint });
      const old = await admitAt(store, 'key-reuse-001', long);
      expect(await store.jobs.get(owner, old.job.jobId)).toBeNull();
      const fresh = await admitAt(store, 'key-reuse-001', new Date());
      expect(fresh.replayed).toBe(false);
      expect(fresh.job.jobId).not.toBe(old.job.jobId);

      const create = (now: Date) =>
        store.sessions.create({
          ownerId: owner,
          clientRequestId: 'session-reuse-1',
          requestHash: 'h',
          purpose: 'improve',
          context: {
            sourceHash: 'a'.repeat(64),
            jobDescriptionHash: null,
            contextHash: 'b'.repeat(64),
          } as never,
          now,
        });
      const oldSession = await create(long);
      const freshSession = await create(new Date());
      expect(freshSession.replayed).toBe(false);
      expect(freshSession.session.sessionId).not.toBe(oldSession.session.sessionId);
    });

    it('shows a succeeded job whose result has aged out as expired, on get and on list', async () => {
      const jobs = createDynamoJobStore(db);
      const now = new Date();
      const { job } = await admitAt(createDynamoStore({ tables, endpoint }), 'key-gone-0001', now);
      await markSucceeded(job.jobId);
      const gone = {
        status: 'expired',
        stage: 'done',
        result: null,
        error: { code: 'deadline_exceeded' },
      };
      expect(await jobs.get(owner, job.jobId)).toMatchObject(gone);
      expect((await jobs.list(owner, null, 10)).jobs[0]).toMatchObject(gone);
      // Once a result exists it is shown instead.
      await jobs.putResult(owner, job.jobId, { ok: 1 }, now);
      expect(await jobs.get(owner, job.jobId)).toMatchObject({
        status: 'succeeded',
        result: { ok: 1 },
      });
    });

    it('asks again for result keys DynamoDB leaves unprocessed', async () => {
      const jobs = createDynamoJobStore(db);
      const now = new Date();
      const { job } = await admitAt(createDynamoStore({ tables, endpoint }), 'key-batch-001', now);
      await markSucceeded(job.jobId);
      await jobs.putResult(owner, job.jobId, { ok: 2 }, now);

      const send = db.client.send.bind(db.client);
      let batches = 0;
      const spy = jest.spyOn(db.client, 'send').mockImplementation(((command: {
        constructor: { name: string };
        input: unknown;
      }) => {
        if (command.constructor.name === 'BatchGetCommand' && batches++ === 0) {
          const input = command.input as { RequestItems: Record<string, unknown> };
          return Promise.resolve({ Responses: {}, UnprocessedKeys: input.RequestItems });
        }
        return send(command as never);
      }) as never);
      try {
        const page = await jobs.list(owner, null, 10);
        expect(page.jobs[0]).toMatchObject({ status: 'succeeded', result: { ok: 2 } });
        expect(batches).toBe(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('writes every item with a TTL on the documented schedule', async () => {
      const jobs = createDynamoJobStore(db);
      const now = new Date();
      const { job } = await jobs.admit({
        ownerId: owner,
        plan: 'free',
        pipelineReleaseId: 'v1',
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
      expect((await read(tables.jobs, `INPUT#${job.jobId}`))?.expiresAt).toBe(at + 7 * day);
      const bucket = await read(tables.quotas, `DAY#${utcDay(now)}`);
      expect(bucket?.expiresAt).toBeGreaterThan(at);
    });

    it('returns a published result with a succeeded job', async () => {
      const jobs = createDynamoJobStore(db);
      const now = new Date();
      const { job } = await jobs.admit({
        ownerId: owner,
        plan: 'free',
        pipelineReleaseId: 'v1',
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
