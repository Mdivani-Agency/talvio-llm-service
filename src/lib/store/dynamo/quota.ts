import { unmarshall } from '@aws-sdk/util-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

import { epochSeconds, userKey, type Db } from './db';

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** Day buckets outlive their day by two days, long past any job's deadline. */
const BUCKET_TTL_SECONDS = 3 * 24 * 60 * 60;

const bucketExpiry = (day: string) =>
  epochSeconds(new Date(`${day}T00:00:00.000Z`)) + BUCKET_TTL_SECONDS;

export const dayKey = (ownerId: string, day: string) => ({
  pk: userKey(ownerId),
  sk: `DAY#${day}`,
});
export const activeKey = (ownerId: string) => ({ pk: userKey(ownerId), sk: 'ACTIVE' });
export const limitsKey = (ownerId: string) => ({ pk: userKey(ownerId), sk: 'LIMITS' });
export const accountKey = (day: string) => ({ pk: 'ACCOUNT', sk: `DAY#${day}` });

/*
 * Counter updates for the quota items. Admission and retry take capacity with a condition that
 * the counter is still low enough before the increment, so concurrent requests cannot both pass
 * (DynamoDB conditions cannot add, so the largest allowed value is computed here). Releases are
 * unconditional: they only run in the same transaction that moves the job out of a held state,
 * and that transition is itself conditional on the job's status.
 */

const WITHIN = (name: string) => `(attribute_not_exists(#${name}) OR #${name} <= :max${name})`;

/** Capacity left for one more: the highest allowed value of the counter before the increment. */
const roomFor = (limit: number, increment: number) => limit - increment;

export type Take = {
  /** Counts a new job against the daily job limit (admission, not retry). */
  newJob: boolean;
  reserve: number;
  day: string;
  limits: { jobsPerDay: number; activeJobs: number; dailySpendMicroUsd: number };
  accountCeiling: number;
};

/** The three counter updates that admit one job. Order matters: see `quotaFailure`. */
export function takeQuota(db: Db, ownerId: string, take: Take): TransactItem[] {
  const { reserve, day, limits } = take;
  const expires = bucketExpiry(day);
  const userNames: Record<string, string> = {
    '#jobs': 'jobs',
    '#reserved': 'reservedMicro',
    '#used': 'usedMicro',
    '#exp': 'expiresAt',
  };
  const jobCondition = take.newJob ? `${WITHIN('jobs')} AND ` : '';
  const userValues: Record<string, unknown> = {
    ':r': reserve,
    ':exp': expires,
    ':maxused': roomFor(limits.dailySpendMicroUsd, reserve),
  };
  if (take.newJob) {
    userValues[':one'] = 1;
    userValues[':maxjobs'] = roomFor(limits.jobsPerDay, 1);
  }
  const userUpdate = take.newJob
    ? 'ADD #jobs :one, #reserved :r, #used :r SET #exp = :exp'
    : 'ADD #reserved :r, #used :r SET #exp = :exp';
  return [
    {
      Update: {
        TableName: db.tables.quotas,
        Key: dayKey(ownerId, day),
        UpdateExpression: userUpdate,
        ConditionExpression: `${jobCondition}${WITHIN('used')}`,
        ExpressionAttributeNames: take.newJob
          ? userNames
          : { '#reserved': 'reservedMicro', '#used': 'usedMicro', '#exp': 'expiresAt' },
        ExpressionAttributeValues: userValues,
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
    },
    {
      Update: {
        TableName: db.tables.quotas,
        Key: activeKey(ownerId),
        UpdateExpression: 'ADD #active :one',
        ConditionExpression: WITHIN('active'),
        ExpressionAttributeNames: { '#active': 'active' },
        ExpressionAttributeValues: { ':one': 1, ':maxactive': roomFor(limits.activeJobs, 1) },
      },
    },
    {
      Update: {
        TableName: db.tables.quotas,
        Key: accountKey(day),
        UpdateExpression: 'ADD #reserved :r, #used :r SET #exp = :exp',
        ConditionExpression: WITHIN('used'),
        ExpressionAttributeNames: {
          '#reserved': 'reservedMicro',
          '#used': 'usedMicro',
          '#exp': 'expiresAt',
        },
        ExpressionAttributeValues: {
          ':r': reserve,
          ':exp': expires,
          ':maxused': roomFor(take.accountCeiling, reserve),
        },
      },
    },
  ];
}

/** Returns the held slot and unspent reservation of a job that leaves a non-terminal state. */
export function releaseQuota(
  db: Db,
  ownerId: string,
  job: { createdAt: Date; spendReservedMicroUsd: number },
  day: string,
): TransactItem[] {
  const expires = bucketExpiry(day);
  const release = (key: { pk: string; sk: string }): TransactItem => ({
    Update: {
      TableName: db.tables.quotas,
      Key: key,
      UpdateExpression: 'ADD #reserved :neg, #used :neg SET #exp = if_not_exists(#exp, :exp)',
      ExpressionAttributeNames: {
        '#reserved': 'reservedMicro',
        '#used': 'usedMicro',
        '#exp': 'expiresAt',
      },
      ExpressionAttributeValues: { ':neg': -job.spendReservedMicroUsd, ':exp': expires },
    },
  });
  return [
    {
      Update: {
        TableName: db.tables.quotas,
        Key: activeKey(ownerId),
        UpdateExpression: 'ADD #active :neg',
        ExpressionAttributeNames: { '#active': 'active' },
        ExpressionAttributeValues: { ':neg': -1 },
      },
    },
    ...(job.spendReservedMicroUsd > 0
      ? [release(dayKey(ownerId, day)), release(accountKey(day))]
      : []),
  ];
}

/**
 * Refusals that need no round trip: a limit lower than one more job can never be satisfied, and
 * the conditions above would let a counter that does not exist yet through.
 */
export function preflight(take: Take): QuotaFailure | null {
  if (take.newJob && take.limits.jobsPerDay < 1) return 'jobs_per_day';
  if (take.limits.activeJobs < 1) return 'active_jobs';
  if (take.limits.dailySpendMicroUsd < take.reserve) return 'daily_spend';
  if (take.accountCeiling < take.reserve) return 'account_ceiling';
  return null;
}

export type QuotaFailure = 'jobs_per_day' | 'active_jobs' | 'daily_spend' | 'account_ceiling';

/**
 * Names the limit that cancelled a transaction whose quota updates start at `offset` (in the
 * order takeQuota returns them), or null when the cancellation came from somewhere else.
 */
export function quotaFailure(
  error: unknown,
  offset: number,
  take: Pick<Take, 'newJob' | 'limits'>,
): QuotaFailure | null {
  if (!(error instanceof TransactionCanceledException)) {
    return null;
  }
  const reasons = error.CancellationReasons ?? [];
  const failed = (index: number) => reasons[offset + index]?.Code === 'ConditionalCheckFailed';
  if (failed(0)) {
    const old = reasons[offset]?.Item ? unmarshall(reasons[offset].Item) : {};
    const jobs = typeof old.jobs === 'number' ? old.jobs : 0;
    return take.newJob && jobs > take.limits.jobsPerDay - 1 ? 'jobs_per_day' : 'daily_spend';
  }
  if (failed(1)) {
    return 'active_jobs';
  }
  if (failed(2)) {
    return 'account_ceiling';
  }
  return null;
}

/** True when the transaction item at `index` is what failed its condition. */
export function failedAt(error: unknown, index: number): boolean {
  return (
    error instanceof TransactionCanceledException &&
    error.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed'
  );
}
