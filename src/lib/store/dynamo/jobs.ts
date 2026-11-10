import { randomUUID } from 'crypto';

import { BatchGetCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { TERMINAL_JOB_STATUSES, type JobError } from '@talvio/llm-contracts';

import {
  DEFAULT_ACCOUNT_DAILY_CEILING_MICRO_USD,
  PLAN_LIMITS,
  PRICING_VERSION,
  QuotaExceededError,
  RETENTION_MS,
  limitOverrideSchema,
  resolveLimits,
  type LimitOverride,
  type ResolvedLimits,
  type UserLimits,
} from '../../limits';
import type { Plan } from '../../plans';
import {
  IdempotencyConflictError,
  InvalidCursorError,
  type AdmitJobInput,
  type JobRecord,
  type JobStage,
  type JobStore,
  type OutboxEvent,
} from '../types';
import {
  epochSeconds,
  isExpired,
  transact as runTransaction,
  userKey,
  utcDay,
  type Db,
  type TransactItem,
} from './db';
import { eventItem } from './outbox';
import { failedAt, limitsKey, preflight, quotaFailure, releaseQuota, takeQuota } from './quota';

const jobKey = (ownerId: string, jobId: string) => ({ pk: userKey(ownerId), sk: `JOB#${jobId}` });
const idemKey = (ownerId: string, key: string) => ({ pk: userKey(ownerId), sk: `IDEM#${key}` });
const resultKey = (ownerId: string, jobId: string) => ({
  pk: userKey(ownerId),
  sk: `RESULT#${jobId}`,
});

type JobItem = {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  jobId: string;
  ownerId: string;
  operation: JobRecord['operation'];
  status: JobRecord['status'];
  stage: JobStage;
  sessionId: string | null;
  contextRevisionId: string | null;
  parentJobId: string | null;
  idempotencyKey: string;
  requestHash: string;
  plan: Plan;
  limitsVersion: string;
  budgetCapMicroUsd: number;
  spendReservedMicroUsd: number;
  spendCommittedMicroUsd: number;
  pricingVersion: string;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  error: JobError | null;
  expiresAt: number;
};

type IdemItem = { jobId: string; requestHash: string; expiresAt: number };
type ResultItem = { result: unknown; expiresAt: number };

const toRecord = (item: JobItem, result: unknown | null): JobRecord => ({
  jobId: item.jobId,
  ownerId: item.ownerId,
  operation: item.operation,
  status: item.status,
  stage: item.stage,
  sessionId: item.sessionId,
  contextRevisionId: item.contextRevisionId,
  parentJobId: item.parentJobId,
  idempotencyKey: item.idempotencyKey,
  requestHash: item.requestHash,
  plan: item.plan,
  budgetCapMicroUsd: item.budgetCapMicroUsd,
  spendReservedMicroUsd: item.spendReservedMicroUsd,
  spendCommittedMicroUsd: item.spendCommittedMicroUsd,
  pricingVersion: item.pricingVersion,
  createdAt: new Date(item.createdAt),
  updatedAt: new Date(item.updatedAt),
  deadlineAt: new Date(item.deadlineAt),
  result,
  error: item.error,
});

const held = (job: Pick<JobRecord, 'status'>) => !TERMINAL_JOB_STATUSES.includes(job.status);

/** Compare-and-set attempts for cancel, retry and delete when a worker changes the job meanwhile. */
const ATTEMPTS = 3;

/** A job's opaque cursor carries only the sort key; the owner part is always rebuilt. */
const encodeCursor = (gsi1sk: string) => Buffer.from(gsi1sk).toString('base64url');
const CURSOR_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z#[\w-]+$/;

export type DynamoJobStoreOptions = {
  planLimits?: Record<string, UserLimits>;
  accountDailyCeilingMicroUsd?: number;
};

export type DynamoJobStore = JobStore & {
  /** Publishes the result payload; it expires after the content retention period. Used by the worker (MDI-215). */
  putResult(ownerId: string, jobId: string, result: unknown, now: Date): Promise<void>;
  /** The user's limits as admission would resolve them now. */
  limitsFor(ownerId: string, plan: Plan): Promise<ResolvedLimits>;
};

export function createDynamoJobStore(db: Db, options: DynamoJobStoreOptions = {}): DynamoJobStore {
  const planLimits = options.planLimits ?? PLAN_LIMITS;
  const accountCeiling =
    options.accountDailyCeilingMicroUsd ?? DEFAULT_ACCOUNT_DAILY_CEILING_MICRO_USD;
  const { client, tables } = db;

  async function loadOverride(ownerId: string): Promise<LimitOverride | null> {
    const { Item } = await client.send(
      new GetCommand({ TableName: tables.quotas, Key: limitsKey(ownerId), ConsistentRead: true }),
    );
    if (!Item) {
      return null;
    }
    // An override that no longer parses is ignored rather than guessed at: plan defaults apply.
    const { pk: _pk, sk: _sk, ...fields } = Item;
    const parsed = limitOverrideSchema.safeParse(fields);
    return parsed.success ? parsed.data : null;
  }

  const limitsFor = async (ownerId: string, plan: Plan) =>
    resolveLimits(plan, await loadOverride(ownerId), planLimits);

  async function loadItem(ownerId: string, jobId: string, now: Date): Promise<JobItem | null> {
    const { Item } = await client.send(
      new GetCommand({ TableName: tables.jobs, Key: jobKey(ownerId, jobId), ConsistentRead: true }),
    );
    return Item && !isExpired(Item, now) ? (Item as JobItem) : null;
  }

  async function loadResult(ownerId: string, jobId: string, now: Date): Promise<unknown | null> {
    const { Item } = await client.send(
      new GetCommand({
        TableName: tables.jobs,
        Key: resultKey(ownerId, jobId),
        ConsistentRead: true,
      }),
    );
    return Item && !isExpired(Item, now) ? ((Item as ResultItem).result ?? null) : null;
  }

  async function load(ownerId: string, jobId: string, now = new Date()): Promise<JobRecord | null> {
    const item = await loadItem(ownerId, jobId, now);
    if (!item) {
      return null;
    }
    return toRecord(
      item,
      item.status === 'succeeded' ? await loadResult(ownerId, jobId, now) : null,
    );
  }

  async function findByIdempotencyKey(ownerId: string, key: string) {
    const { Item } = await client.send(
      new GetCommand({ TableName: tables.jobs, Key: idemKey(ownerId, key), ConsistentRead: true }),
    );
    if (!Item || isExpired(Item, new Date())) {
      return null;
    }
    return load(ownerId, (Item as IdemItem).jobId);
  }

  const replayOrConflict = (existing: JobRecord, requestHash: string) => {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError();
    }
    return { job: existing, replayed: true };
  };

  const transact = (items: TransactItem[]) => runTransaction(db, items);

  async function admit(input: AdmitJobInput) {
    const { ownerId, plan, idempotencyKey, requestHash, request, now, deadlineAt } = input;

    // A replay is answered before any quota is touched.
    const existing = await findByIdempotencyKey(ownerId, idempotencyKey);
    if (existing) {
      return replayOrConflict(existing, requestHash);
    }

    const limits = await limitsFor(ownerId, plan);
    const reserve = limits.jobBudgetMicroUsd;
    const day = utcDay(now);
    const take = { newJob: true, reserve, day, limits, accountCeiling };
    const refused = preflight(take);
    if (refused) {
      throw new QuotaExceededError(refused);
    }

    const session = 'sessionId' in request ? request : null;
    const jobId = randomUUID();
    const createdAt = now.toISOString();
    const expiresAt = epochSeconds(now) + RETENTION_MS.metadata / 1000;
    const record: JobItem = {
      ...jobKey(ownerId, jobId),
      gsi1pk: `${userKey(ownerId)}#JOBS`,
      gsi1sk: `${createdAt}#${jobId}`,
      jobId,
      ownerId,
      operation: request.operation,
      status: 'queued',
      stage: 'admission',
      sessionId: session?.sessionId ?? null,
      contextRevisionId: session?.contextRevisionId ?? null,
      parentJobId: session?.parentJobId ?? null,
      idempotencyKey,
      requestHash,
      plan,
      limitsVersion: limits.version,
      budgetCapMicroUsd: reserve,
      spendReservedMicroUsd: reserve,
      spendCommittedMicroUsd: 0,
      pricingVersion: PRICING_VERSION,
      createdAt,
      updatedAt: createdAt,
      deadlineAt: deadlineAt.toISOString(),
      error: null,
      expiresAt,
    };
    const event: OutboxEvent = {
      eventId: randomUUID(),
      type: 'job.admitted',
      ownerId,
      jobId,
      operation: request.operation,
      createdAt: now,
    };

    try {
      // One transaction: the job, its idempotency record, the quota and spend holds and the
      // outbox event are all written, or none are. Nothing here waits on a model or OCR call.
      await transact([
        {
          Put: {
            TableName: tables.jobs,
            Item: record,
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: tables.jobs,
            Item: { ...idemKey(ownerId, idempotencyKey), jobId, requestHash, expiresAt },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        ...takeQuota(db, ownerId, take),
        { Put: { TableName: tables.outbox, Item: eventItem(event, expiresAt) } },
      ]);
    } catch (error) {
      if (failedAt(error, 1)) {
        // Another request with this key won the race: answer it as a replay.
        const winner = await findByIdempotencyKey(ownerId, idempotencyKey);
        if (winner) {
          return replayOrConflict(winner, requestHash);
        }
      }
      const kind = quotaFailure(error, 2, take);
      if (kind) {
        throw new QuotaExceededError(kind);
      }
      throw error;
    }
    return { job: toRecord(record, null), replayed: false };
  }

  async function list(ownerId: string, cursor: string | null, limit: number) {
    let startKey: Record<string, string> | undefined;
    if (cursor) {
      const gsi1sk = Buffer.from(cursor, 'base64url').toString();
      const id = gsi1sk.split('#').pop() ?? '';
      if (!CURSOR_RE.test(gsi1sk)) {
        throw new InvalidCursorError();
      }
      startKey = {
        ...jobKey(ownerId, id),
        gsi1pk: `${userKey(ownerId)}#JOBS`,
        gsi1sk,
      };
    }
    const now = new Date();
    const page = await client.send(
      new QueryCommand({
        TableName: tables.jobs,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :owner',
        FilterExpression: 'expiresAt > :now',
        ExpressionAttributeValues: {
          ':owner': `${userKey(ownerId)}#JOBS`,
          ':now': epochSeconds(now),
        },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: startKey,
      }),
    );
    const items = (page.Items ?? []) as JobItem[];
    const succeeded = items.filter((item) => item.status === 'succeeded');
    const results = new Map<string, unknown>();
    if (succeeded.length > 0) {
      const batch = await client.send(
        new BatchGetCommand({
          RequestItems: {
            [tables.jobs]: {
              Keys: succeeded.map((item) => resultKey(ownerId, item.jobId)),
              ConsistentRead: true,
            },
          },
        }),
      );
      for (const found of (batch.Responses?.[tables.jobs] ?? []) as (ResultItem & {
        sk: string;
      })[]) {
        if (!isExpired(found, now)) {
          results.set(found.sk.slice('RESULT#'.length), found.result);
        }
      }
    }
    const last = page.LastEvaluatedKey?.gsi1sk;
    return {
      jobs: items.map((item) => toRecord(item, results.get(item.jobId) ?? null)),
      nextCursor: typeof last === 'string' ? encodeCursor(last) : null,
    };
  }

  async function cancel(ownerId: string, jobId: string, now: Date) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const job = await load(ownerId, jobId, now);
      if (!job || !held(job)) {
        return job;
      }
      try {
        await transact([
          {
            Update: {
              TableName: tables.jobs,
              Key: jobKey(ownerId, jobId),
              UpdateExpression:
                'SET #status = :cancelled, #stage = :done, updatedAt = :now, spendReservedMicroUsd = :zero',
              ConditionExpression: '#status = :seen',
              ExpressionAttributeNames: { '#status': 'status', '#stage': 'stage' },
              ExpressionAttributeValues: {
                ':cancelled': 'cancelled',
                ':done': 'done',
                ':seen': job.status,
                ':now': now.toISOString(),
                ':zero': 0,
              },
            },
          },
          ...releaseQuota(db, ownerId, job, utcDay(job.createdAt)),
        ]);
        return load(ownerId, jobId, now);
      } catch (error) {
        if (!failedAt(error, 0)) {
          throw error;
        }
      }
    }
    throw new Error('job changed too often to cancel');
  }

  async function retry(ownerId: string, jobId: string, now: Date) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const job = await load(ownerId, jobId, now);
      if (!job || held(job)) {
        return job;
      }
      const limits = await limitsFor(ownerId, job.plan);
      const reserve = job.budgetCapMicroUsd;
      const day = utcDay(job.createdAt);
      const take = { newJob: false, reserve, day, limits, accountCeiling };
      const refused = preflight(take);
      if (refused) {
        throw new QuotaExceededError(refused);
      }
      const expiresAt = epochSeconds(job.createdAt) + RETENTION_MS.metadata / 1000;
      const event: OutboxEvent = {
        eventId: randomUUID(),
        type: 'job.retried',
        ownerId,
        jobId,
        operation: job.operation,
        createdAt: now,
      };
      try {
        await transact([
          {
            Update: {
              TableName: tables.jobs,
              Key: jobKey(ownerId, jobId),
              UpdateExpression:
                'SET #status = :queued, #stage = :admission, #error = :none, updatedAt = :now, spendReservedMicroUsd = :reserve',
              ConditionExpression: '#status = :seen',
              ExpressionAttributeNames: {
                '#status': 'status',
                '#stage': 'stage',
                '#error': 'error',
              },
              ExpressionAttributeValues: {
                ':queued': 'queued',
                ':admission': 'admission',
                ':none': null,
                ':seen': job.status,
                ':now': now.toISOString(),
                ':reserve': reserve,
              },
            },
          },
          ...takeQuota(db, ownerId, take),
          { Put: { TableName: tables.outbox, Item: eventItem(event, expiresAt) } },
        ]);
        return load(ownerId, jobId, now);
      } catch (error) {
        if (failedAt(error, 0)) {
          continue;
        }
        const kind = quotaFailure(error, 1, take);
        if (kind) {
          throw new QuotaExceededError(kind);
        }
        throw error;
      }
    }
    throw new Error('job changed too often to retry');
  }

  async function remove(ownerId: string, jobId: string) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const job = await load(ownerId, jobId);
      if (!job) {
        return false;
      }
      try {
        await transact([
          {
            Delete: {
              TableName: tables.jobs,
              Key: jobKey(ownerId, jobId),
              ConditionExpression: '#status = :seen',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':seen': job.status },
            },
          },
          { Delete: { TableName: tables.jobs, Key: idemKey(ownerId, job.idempotencyKey) } },
          { Delete: { TableName: tables.jobs, Key: resultKey(ownerId, jobId) } },
          ...(held(job) ? releaseQuota(db, ownerId, job, utcDay(job.createdAt)) : []),
        ]);
        return true;
      } catch (error) {
        if (!failedAt(error, 0)) {
          throw error;
        }
      }
    }
    throw new Error('job changed too often to delete');
  }

  return {
    findByIdempotencyKey,
    admit,
    get: (ownerId, jobId) => load(ownerId, jobId),
    list,
    cancel,
    retry,
    delete: remove,
    limitsFor,
    async putResult(ownerId, jobId, result, now) {
      const item = await loadItem(ownerId, jobId, now);
      if (!item) {
        throw new Error('job not found for this owner');
      }
      await client.send(
        new PutCommand({
          TableName: tables.jobs,
          Item: {
            ...resultKey(ownerId, jobId),
            result,
            expiresAt: epochSeconds(now) + RETENTION_MS.content / 1000,
          },
        }),
      );
    },
  };
}
