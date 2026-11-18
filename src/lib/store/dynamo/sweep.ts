import { createHash } from 'crypto';

import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { RETENTION_MS } from '../../limits';
import { epochSeconds, userKey, type Db, type TransactItem } from './db';

/*
 * The reconciler's work list. While a job is not terminal it has one item here (outbox table, sparse
 * GSI1) saying when it is next worth looking at: when its lease expires, when its retry is due plus
 * a grace for delivery, or its deadline, whichever comes first. Every state change that moves that
 * time rewrites the item in the same transaction, and a terminal change deletes it, so the list is
 * exactly the live jobs and the reconciler never scans.
 */

export const SWEEP_SHARDS = 8;

const shardOf = (jobId: string) =>
  (createHash('sha256').update(jobId).digest()[0] ?? 0) % SWEEP_SHARDS;

export const sweepKey = (ownerId: string, jobId: string) => ({
  pk: userKey(ownerId),
  sk: `SWEEP#${jobId}`,
});

const checkSort = (checkAt: Date, jobId: string) => `${checkAt.toISOString()}#${jobId}`;

/** The job's next look, never later than its deadline. */
export function nextCheck(after: Date, deadlineAt: Date): Date {
  return after < deadlineAt ? after : deadlineAt;
}

export function sweepPut(
  db: Db,
  job: { ownerId: string; jobId: string; deadlineAt: Date },
  after: Date,
): TransactItem {
  const checkAt = nextCheck(after, job.deadlineAt);
  return {
    Put: {
      TableName: db.tables.outbox,
      Item: {
        ...sweepKey(job.ownerId, job.jobId),
        gsi1pk: `SWEEP#${shardOf(job.jobId)}`,
        gsi1sk: checkSort(checkAt, job.jobId),
        ownerId: job.ownerId,
        jobId: job.jobId,
        expiresAt: epochSeconds(job.deadlineAt) + RETENTION_MS.metadata / 1000,
      },
    },
  };
}

export function sweepDelete(db: Db, ownerId: string, jobId: string): TransactItem {
  return { Delete: { TableName: db.tables.outbox, Key: sweepKey(ownerId, jobId) } };
}

/** Live jobs whose next look is due, oldest first. A system reader across users: only the reconciler calls it. */
export async function dueSweeps(db: Db, now: Date, limit: number) {
  const pages = await Promise.all(
    Array.from({ length: SWEEP_SHARDS }, (_, shard) =>
      db.client.send(
        new QueryCommand({
          TableName: db.tables.outbox,
          IndexName: 'GSI1',
          KeyConditionExpression: 'gsi1pk = :shard AND gsi1sk <= :now',
          ExpressionAttributeValues: {
            ':shard': `SWEEP#${shard}`,
            ':now': `${now.toISOString()}#￿`,
          },
          Limit: limit,
        }),
      ),
    ),
  );
  return pages
    .flatMap((page) => (page.Items ?? []) as { gsi1sk: string; ownerId: string; jobId: string }[])
    .sort((left, right) => left.gsi1sk.localeCompare(right.gsi1sk))
    .slice(0, limit)
    .map(({ ownerId, jobId }) => ({ ownerId, jobId }));
}
