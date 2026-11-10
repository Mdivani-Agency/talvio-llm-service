import { randomUUID } from 'crypto';

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { JobError } from '@talvio/llm-contracts';

import { DISPATCH_GRACE_MS } from '../../execution';
import { RETENTION_MS } from '../../limits';
import type {
  ClaimResult,
  ExecutionStore,
  JobStage,
  Lease,
  OutboxEvent,
  ReconcileResult,
  SkipReason,
  WriteResult,
} from '../types';
import { epochSeconds, transact, utcDay, type Db, type TransactItem } from './db';
import { held, jobKey, resultKey, toRecord, type JobItem } from './job-items';
import { eventItem } from './outbox';
import { settleQuota, failedAt } from './quota';
import { dueSweeps, sweepDelete, sweepKey, sweepPut } from './sweep';

const deadlineError = (jobId: string): JobError => ({
  code: 'deadline_exceeded',
  message: 'The job did not finish before its deadline.',
  retryable: false,
  correlationId: jobId,
});

/** Names used by the guarded updates below. */
const NAMES = {
  '#status': 'status',
  '#stage': 'stage',
  '#error': 'error',
  '#exec': 'exec',
  '#fence': 'fence',
  '#lease': 'leaseExpiresAt',
  '#available': 'availableAt',
  '#external': 'externalRef',
  '#attempts': 'stepAttempts',
  '#checkpoints': 'checkpoints',
};

/**
 * Executor transitions on DynamoDB. Every write is conditional on the job's status and fence, and
 * every change of state is one transaction with its quota settlement, outbox event and sweep item,
 * so a crash between steps cannot leave a job half moved. A write that loses its condition tells
 * the caller `stale`; the one exception is a repeat of a terminal write by the same lease, which is
 * recognized by the fence it left behind and answered `applied`.
 */
export function createDynamoExecutionStore(db: Db): ExecutionStore {
  const { client, tables } = db;

  async function item(ownerId: string, jobId: string): Promise<JobItem | null> {
    const { Item } = await client.send(
      new GetCommand({ TableName: tables.jobs, Key: jobKey(ownerId, jobId), ConsistentRead: true }),
    );
    return (Item as JobItem | undefined) ?? null;
  }

  const record = (it: JobItem) => toRecord(it, null);
  const deadline = (it: JobItem) => new Date(it.deadlineAt);
  const metaExpiry = (now: Date) => epochSeconds(now) + RETENTION_MS.metadata / 1000;

  const event = (
    type: OutboxEvent['type'],
    it: JobItem,
    now: Date,
    availableAt = now,
  ): OutboxEvent => ({
    eventId: randomUUID(),
    type,
    ownerId: it.ownerId,
    jobId: it.jobId,
    operation: it.operation,
    pipelineReleaseId: it.exec.pipelineReleaseId,
    createdAt: now,
    availableAt,
  });

  const putEvent = (e: OutboxEvent, now: Date): TransactItem => ({
    Put: { TableName: tables.outbox, Item: eventItem(e, metaExpiry(now)) },
  });

  /**
   * Moves a job to a terminal status, settling its hold. Guarded by the status and fence the
   * caller saw, so only one terminal write wins: a worker, the reconciler, a dead letter or a
   * cancel.
   */
  async function terminate(
    it: JobItem,
    to: 'succeeded' | 'failed' | 'expired',
    now: Date,
    options: { error?: JobError | null; committedTotal?: number; result?: unknown },
  ): Promise<boolean> {
    const committedTotal = Math.min(
      options.committedTotal ?? it.spendCommittedMicroUsd,
      it.budgetCapMicroUsd,
    );
    const day = utcDay(new Date(it.createdAt));
    const updates: TransactItem[] = [
      {
        Update: {
          TableName: tables.jobs,
          Key: jobKey(it.ownerId, it.jobId),
          UpdateExpression:
            'SET #status = :to, #stage = :done, #error = :error, updatedAt = :now, ' +
            'spendReservedMicroUsd = :zero, spendCommittedMicroUsd = :committed, ' +
            '#exec.#fence = #exec.#fence + :one, #exec.#lease = :none, ' +
            '#exec.#available = :none, #exec.#external = :none',
          ConditionExpression: '#status = :seen AND #exec.#fence = :fence',
          ExpressionAttributeNames: pick(
            '#status #stage #error #exec #fence #lease #available #external',
          ),
          ExpressionAttributeValues: {
            ':to': to,
            ':done': 'done',
            ':error': options.error ?? null,
            ':now': now.toISOString(),
            ':zero': 0,
            ':committed': committedTotal,
            ':one': 1,
            ':none': null,
            ':seen': it.status,
            ':fence': it.exec.fence,
          },
        },
      },
      ...settleQuota(db, it.ownerId, it, committedTotal, day),
      sweepDelete(db, it.ownerId, it.jobId),
    ];
    if (to === 'succeeded') {
      updates.push({
        Put: {
          TableName: tables.jobs,
          Item: {
            ...resultKey(it.ownerId, it.jobId),
            result: options.result,
            expiresAt: epochSeconds(now) + RETENTION_MS.content / 1000,
          },
        },
      });
    }
    try {
      await transact(db, updates);
      return true;
    } catch (error) {
      if (failedAt(error, 0)) {
        return false;
      }
      throw error;
    }
  }

  /** The job a lease still owns, or null (cancelled, deleted, expired, or a newer lease took over). */
  async function owned(lease: Lease): Promise<JobItem | null> {
    const it = await item(lease.ownerId, lease.jobId);
    return it && it.status === 'running' && it.exec.fence === lease.fence ? it : null;
  }

  /** True when a terminal write by this lease already landed (it left fence + 1 behind). */
  async function alreadyEnded(lease: Lease, to: JobItem['status']): Promise<boolean> {
    const it = await item(lease.ownerId, lease.jobId);
    return it !== null && it.status === to && it.exec.fence === lease.fence + 1;
  }

  /** A guarded update of a running job's own fields, with the extra items that go with it. */
  async function guarded(
    lease: Lease,
    set: string,
    values: Record<string, unknown>,
    extra: TransactItem[],
    names: Record<string, string> = {},
  ): Promise<WriteResult> {
    try {
      await transact(db, [
        {
          Update: {
            TableName: tables.jobs,
            Key: jobKey(lease.ownerId, lease.jobId),
            UpdateExpression: set,
            ConditionExpression: '#status = :running AND #exec.#fence = :fence',
            ExpressionAttributeNames: { ...pick(set, '#status #exec #fence'), ...names },
            ExpressionAttributeValues: { ...values, ':running': 'running', ':fence': lease.fence },
          },
        },
        ...extra,
      ]);
      return 'applied';
    } catch (error) {
      if (failedAt(error, 0)) {
        return 'stale';
      }
      throw error;
    }
  }

  /** Only the placeholder names an expression uses may be sent. */
  const pick = (...expressions: string[]) => {
    const used = new Set(expressions.join(' ').match(/#[a-zA-Z]+/g) ?? []);
    return Object.fromEntries(Object.entries(NAMES).filter(([name]) => used.has(name)));
  };

  async function claim(
    ownerId: string,
    jobId: string,
    now: Date,
    leaseMs: number,
  ): Promise<ClaimResult> {
    const skipped = (reason: SkipReason): ClaimResult => ({ kind: 'skipped', reason });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const it = await item(ownerId, jobId);
      if (!it) return skipped('missing');
      if (!held(it)) return skipped('terminal');
      if (now >= deadline(it)) {
        await terminate(it, 'expired', now, { error: deadlineError(jobId) });
        return skipped('expired');
      }
      if (it.status === 'waiting_external') return skipped('waiting');
      const leaseEnds = it.exec.leaseExpiresAt ? new Date(it.exec.leaseExpiresAt) : null;
      if (it.status === 'running' && leaseEnds && leaseEnds > now) return skipped('leased');
      const due = it.exec.availableAt ? new Date(it.exec.availableAt) : null;
      if (it.status === 'retry_wait' && due && due > now) return skipped('not_due');

      const expiresAt = new Date(now.getTime() + leaseMs);
      try {
        await transact(db, [
          {
            Update: {
              TableName: tables.jobs,
              Key: jobKey(ownerId, jobId),
              UpdateExpression:
                'SET #status = :running, updatedAt = :now, #exec.#fence = :next, ' +
                '#exec.#lease = :lease, #exec.#available = :none',
              ConditionExpression: '#status = :seen AND #exec.#fence = :fence',
              ExpressionAttributeNames: pick('#status #exec #fence #lease #available'),
              ExpressionAttributeValues: {
                ':running': 'running',
                ':now': now.toISOString(),
                ':next': it.exec.fence + 1,
                ':lease': expiresAt.toISOString(),
                ':none': null,
                ':seen': it.status,
                ':fence': it.exec.fence,
              },
            },
          },
          sweepPut(db, { ownerId, jobId, deadlineAt: deadline(it) }, expiresAt),
        ]);
      } catch (error) {
        if (failedAt(error, 0)) continue;
        throw error;
      }
      const claimed = record({
        ...it,
        status: 'running',
        updatedAt: now.toISOString(),
        exec: {
          ...it.exec,
          fence: it.exec.fence + 1,
          leaseExpiresAt: expiresAt.toISOString(),
          availableAt: null,
        },
      });
      return {
        kind: 'claimed',
        job: claimed,
        lease: { ownerId, jobId, fence: it.exec.fence + 1, expiresAt },
      };
    }
    return skipped('leased');
  }

  return {
    claim,

    async extend(lease, now, leaseMs) {
      const expiresAt = new Date(now.getTime() + leaseMs);
      const it = await item(lease.ownerId, lease.jobId);
      if (!it) return null;
      const result = await guarded(
        lease,
        'SET #exec.#lease = :lease, updatedAt = :now',
        { ':lease': expiresAt.toISOString(), ':now': now.toISOString() },
        [
          sweepPut(
            db,
            { ownerId: lease.ownerId, jobId: lease.jobId, deadlineAt: deadline(it) },
            expiresAt,
          ),
        ],
      );
      return result === 'applied' ? { ...lease, expiresAt } : null;
    },

    async checkpoint(lease, step: JobStage, refs, now) {
      return guarded(
        lease,
        'SET #stage = :step, updatedAt = :now, #exec.#checkpoints.#step = :refs',
        { ':step': step, ':now': now.toISOString(), ':refs': refs },
        [],
        { '#step': step },
      );
    },

    async succeed(lease, result, settlement, now) {
      const it = await owned(lease);
      if (!it) return (await alreadyEnded(lease, 'succeeded')) ? 'applied' : 'stale';
      const ok = await terminate(it, 'succeeded', now, {
        error: null,
        committedTotal: settlement.spendCommittedMicroUsd,
        result,
      });
      return ok ? 'applied' : (await alreadyEnded(lease, 'succeeded')) ? 'applied' : 'stale';
    },

    async fail(lease, error, settlement, now) {
      const it = await owned(lease);
      if (!it) return (await alreadyEnded(lease, 'failed')) ? 'applied' : 'stale';
      const ok = await terminate(it, 'failed', now, {
        error,
        committedTotal: settlement.spendCommittedMicroUsd,
      });
      return ok ? 'applied' : (await alreadyEnded(lease, 'failed')) ? 'applied' : 'stale';
    },

    async retryLater(lease, step: JobStage, availableAt, now) {
      const it = await owned(lease);
      if (!it) return 'stale';
      const e = event('job.retry', it, now, availableAt);
      return guarded(
        lease,
        'SET #status = :wait, #stage = :step, updatedAt = :now, #exec.#fence = #exec.#fence + :one, ' +
          '#exec.#lease = :none, #exec.#available = :at, ' +
          '#exec.#attempts.#step = if_not_exists(#exec.#attempts.#step, :zero) + :one',
        {
          ':wait': 'retry_wait',
          ':step': step,
          ':now': now.toISOString(),
          ':one': 1,
          ':zero': 0,
          ':none': null,
          ':at': availableAt.toISOString(),
        },
        [
          putEvent(e, now),
          sweepPut(
            db,
            { ownerId: it.ownerId, jobId: it.jobId, deadlineAt: deadline(it) },
            new Date(availableAt.getTime() + DISPATCH_GRACE_MS),
          ),
        ],
        { '#step': step },
      );
    },

    async waitExternal(lease, ref, now) {
      const it = await owned(lease);
      if (!it) return 'stale';
      return guarded(
        lease,
        'SET #status = :wait, updatedAt = :now, #exec.#fence = #exec.#fence + :one, ' +
          '#exec.#lease = :none, #exec.#external = :ref',
        {
          ':wait': 'waiting_external',
          ':now': now.toISOString(),
          ':one': 1,
          ':none': null,
          ':ref': ref,
        },
        [
          sweepPut(
            db,
            { ownerId: it.ownerId, jobId: it.jobId, deadlineAt: deadline(it) },
            deadline(it),
          ),
        ],
      );
    },

    async resume(ownerId, jobId, ref, now) {
      const it = await item(ownerId, jobId);
      if (!it || it.status !== 'waiting_external' || it.exec.externalRef !== ref) return false;
      try {
        await transact(db, [
          {
            Update: {
              TableName: tables.jobs,
              Key: jobKey(ownerId, jobId),
              UpdateExpression: 'SET #status = :queued, updatedAt = :now, #exec.#external = :none',
              ConditionExpression: '#status = :waiting AND #exec.#external = :ref',
              ExpressionAttributeNames: pick('#status #exec #external'),
              ExpressionAttributeValues: {
                ':queued': 'queued',
                ':waiting': 'waiting_external',
                ':now': now.toISOString(),
                ':none': null,
                ':ref': ref,
              },
            },
          },
          putEvent(event('job.resume', it, now), now),
          sweepPut(
            db,
            { ownerId, jobId, deadlineAt: deadline(it) },
            new Date(now.getTime() + DISPATCH_GRACE_MS),
          ),
        ]);
        return true;
      } catch (error) {
        if (failedAt(error, 0)) return false;
        throw error;
      }
    },

    async abandon(ownerId, jobId, error, now) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const it = await item(ownerId, jobId);
        if (!it || !held(it)) return 'stale';
        if (await terminate(it, 'failed', now, { error })) return 'applied';
      }
      return 'stale';
    },

    due: (now, limit) => dueSweeps(db, now, limit),

    async reconcile(ownerId, jobId, now): Promise<ReconcileResult> {
      const it = await item(ownerId, jobId);
      if (!it) {
        await transact(db, [
          { Delete: { TableName: tables.outbox, Key: sweepKey(ownerId, jobId) } },
        ]);
        return 'missing';
      }
      if (!held(it)) {
        await transact(db, [sweepDelete(db, ownerId, jobId)]);
        return 'settled';
      }
      if (now >= deadline(it)) {
        await terminate(it, 'expired', now, { error: deadlineError(jobId) });
        return 'expired';
      }
      const next = sweepPut(
        db,
        { ownerId, jobId, deadlineAt: deadline(it) },
        new Date(now.getTime() + DISPATCH_GRACE_MS),
      );
      if (it.status === 'waiting_external') {
        // Parked on an external operation: nothing to republish, only the deadline matters.
        await transact(db, [
          sweepPut(db, { ownerId, jobId, deadlineAt: deadline(it) }, deadline(it)),
        ]);
      } else {
        await transact(db, [putEvent(event('job.requeue', it, now), now), next]);
      }
      return 'requeued';
    },
  };
}
