import { randomUUID } from 'crypto';

import type { CreateJobRequest, JobError } from '@talvio/llm-contracts';

import { QuotaExceededError, type LimitOverride } from '../limits';
import type { Plan } from '../plans';
import {
  IdempotencyConflictError,
  InvalidCursorError,
  QuestionRoundTakenError,
  type ContextInput,
  type Store,
} from './types';

/*
 * Behavior every store must have. Run against the memory store in memory.spec.ts and against
 * DynamoDB Local in dynamo/dynamo.spec.ts (CI), so the two cannot drift.
 */

export type Harness = {
  store: Store;
  setLimitOverride(ownerId: string, override: LimitOverride): Promise<void>;
  /** Moves a held job to failed the way the worker will: status, error and slot/reservation release. */
  failJob(ownerId: string, jobId: string): Promise<void>;
};

export type MakeHarness = (options: {
  planLimits?: Record<
    string,
    { jobsPerDay: number; activeJobs: number; dailySpendMicroUsd: number; jobCapMicroUsd: number }
  >;
  accountDailyCeilingMicroUsd?: number;
}) => Promise<Harness>;

const FREE = 'free' as Plan;
// Noon UTC today: retention is measured against the real clock, so a fixed date would age out.
const NOW = new Date();
NOW.setUTCHours(12, 0, 0, 0);
const DEADLINE = new Date(NOW.getTime() + 10 * 60 * 1000);

const request = (key: string): CreateJobRequest =>
  ({
    schemaVersion: '1.0',
    clientRequestId: key,
    operation: 'parse_document',
    input: { kind: 'text', text: 'Nino Beridze\nBackend engineer', extraction: null },
  }) as CreateJobRequest;

const context = (): ContextInput => ({
  source: {} as ContextInput['source'],
  jobDescription: null,
  sourceHash: 'a'.repeat(64),
  jobDescriptionHash: null,
  contextHash: 'b'.repeat(64),
});

const expiredError = (jobId: string, code = 'deadline_exceeded'): JobError =>
  ({ code, message: 'x', retryable: false, correlationId: jobId }) as JobError;

const WIDE: LimitOverride = { jobsPerDay: 100, activeJobs: 100, dailySpendMicroUsd: 100_000_000 };

export function describeStoreContract(name: string, make: MakeHarness) {
  describe(`${name} store`, () => {
    // Fresh users per test: DynamoDB tables are shared by the whole suite.
    let alice = randomUUID();
    let bob = randomUUID();
    let h: Harness;

    beforeEach(() => {
      alice = randomUUID();
      bob = randomUUID();
    });

    /** Undispatched events of this test's users; the outbox is system-wide. */
    const pending = async () =>
      (await h.store.outbox.pending(1000, new Date(Date.now() + 1e9))).filter(
        (e) => e.ownerId === alice || e.ownerId === bob,
      );

    const admit = (owner: string, key: string, hash = `hash-${key}`, now = NOW) =>
      h.store.jobs.admit({
        ownerId: owner,
        plan: FREE,
        pipelineReleaseId: 'v1',
        idempotencyKey: key,
        requestHash: hash,
        request: request(key),
        now,
        deadlineAt: new Date(now.getTime() + 10 * 60 * 1000),
      });

    describe('jobs', () => {
      beforeEach(async () => {
        h = await make({});
      });

      it('admits a queued job holding its budget, and writes the outbox event', async () => {
        const { job, replayed } = await admit(alice, 'key-00000001');
        expect(replayed).toBe(false);
        expect(job).toMatchObject({
          ownerId: alice,
          status: 'queued',
          stage: 'admission',
          plan: 'free',
          exec: expect.objectContaining({ pipelineReleaseId: 'v1', fence: 0 }),
          budgetCapMicroUsd: 50_000,
          spendReservedMicroUsd: 50_000,
          spendCommittedMicroUsd: 0,
        });
        expect(job.deadlineAt).toEqual(DEADLINE);
        expect(await h.store.jobs.get(alice, job.jobId)).toMatchObject({ jobId: job.jobId });
        const events = await pending();
        expect(events).toEqual([
          expect.objectContaining({ type: 'job.admitted', jobId: job.jobId, ownerId: alice }),
        ]);
      });

      it('keeps the admitted request for its owner only', async () => {
        const { job } = await admit(alice, 'key-00000001');
        expect(await h.store.jobs.input(alice, job.jobId)).toEqual(request('key-00000001'));
        expect(await h.store.jobs.input(bob, job.jobId)).toBeNull();
      });

      it('returns the same job for the same key and request, without a second hold or event', async () => {
        await h.setLimitOverride(alice, { ...WIDE, jobsPerDay: 2 });
        const first = await admit(alice, 'key-00000001');
        const replay = await admit(alice, 'key-00000001');
        expect(replay).toEqual({ job: first.job, replayed: true, event: null });
        expect(await pending()).toHaveLength(1);
        // The replay used no quota: the day still has room for two more distinct jobs... of which one fits.
        await admit(alice, 'key-00000002');
        await expect(admit(alice, 'key-00000003')).rejects.toMatchObject({ kind: 'jobs_per_day' });
      });

      it('refuses the same key with a different request', async () => {
        await admit(alice, 'key-00000001', 'hash-one');
        await expect(admit(alice, 'key-00000001', 'hash-two')).rejects.toBeInstanceOf(
          IdempotencyConflictError,
        );
        expect(await pending()).toHaveLength(1);
      });

      it('finds a job by its key for its owner only', async () => {
        const { job } = await admit(alice, 'key-00000001');
        expect(await h.store.jobs.findByIdempotencyKey(alice, 'key-00000001')).toMatchObject({
          jobId: job.jobId,
        });
        expect(await h.store.jobs.findByIdempotencyKey(bob, 'key-00000001')).toBeNull();
      });

      it('lets two users use the same key independently', async () => {
        const a = await admit(alice, 'key-00000001');
        const b = await admit(bob, 'key-00000001');
        expect(b.replayed).toBe(false);
        expect(b.job.jobId).not.toBe(a.job.jobId);
      });

      it('allows two active jobs on the free plan and refuses the third', async () => {
        await admit(alice, 'key-00000001');
        await admit(alice, 'key-00000002');
        await expect(admit(alice, 'key-00000003')).rejects.toEqual(
          new QuotaExceededError('active_jobs'),
        );
        // Nothing was written for the refused request.
        expect((await h.store.jobs.list(alice, null, 10)).jobs).toHaveLength(2);
        expect(await pending()).toHaveLength(2);
        expect(await h.store.jobs.findByIdempotencyKey(alice, 'key-00000003')).toBeNull();
      });

      it('frees the slot and the reservation when a job is cancelled', async () => {
        const first = await admit(alice, 'key-00000001');
        await admit(alice, 'key-00000002');
        const cancelled = await h.store.jobs.cancel(alice, first.job.jobId, NOW);
        expect(cancelled).toMatchObject({
          status: 'cancelled',
          stage: 'done',
          spendReservedMicroUsd: 0,
        });
        await expect(admit(alice, 'key-00000003')).resolves.toMatchObject({ replayed: false });
        // A second cancel changes nothing.
        expect(await h.store.jobs.cancel(alice, first.job.jobId, NOW)).toMatchObject({
          status: 'cancelled',
        });
        await expect(admit(alice, 'key-00000004')).rejects.toMatchObject({ kind: 'active_jobs' });
      });

      it('refuses past the daily job limit, per UTC day', async () => {
        await h.setLimitOverride(alice, { ...WIDE, jobsPerDay: 2 });
        await admit(alice, 'key-00000001');
        await admit(alice, 'key-00000002');
        await expect(admit(alice, 'key-00000003')).rejects.toMatchObject({ kind: 'jobs_per_day' });
        const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
        await expect(admit(alice, 'key-00000003', 'hash-x', tomorrow)).resolves.toMatchObject({
          replayed: false,
        });
      });

      it('refuses past the daily spend limit, counting reservations', async () => {
        await h.setLimitOverride(alice, { ...WIDE, dailySpendMicroUsd: 100_000 });
        await admit(alice, 'key-00000001');
        await admit(alice, 'key-00000002');
        await expect(admit(alice, 'key-00000003')).rejects.toMatchObject({ kind: 'daily_spend' });
      });

      it('refuses a user whose limits cannot fit one job', async () => {
        await h.setLimitOverride(alice, { ...WIDE, dailySpendMicroUsd: 10_000 });
        await expect(admit(alice, 'key-00000001')).rejects.toMatchObject({ kind: 'daily_spend' });
        await h.setLimitOverride(bob, { ...WIDE, activeJobs: 0 });
        await expect(admit(bob, 'key-00000001')).rejects.toMatchObject({ kind: 'active_jobs' });
        await h.setLimitOverride(bob, { ...WIDE, jobsPerDay: 0 });
        await expect(admit(bob, 'key-00000001')).rejects.toMatchObject({ kind: 'jobs_per_day' });
      });

      it('applies a raised override on top of the plan', async () => {
        await h.setLimitOverride(alice, { ...WIDE, activeJobs: 3 });
        await admit(alice, 'key-00000001');
        await admit(alice, 'key-00000002');
        await expect(admit(alice, 'key-00000003')).resolves.toMatchObject({ replayed: false });
        await expect(admit(alice, 'key-00000004')).rejects.toMatchObject({ kind: 'active_jobs' });
      });

      it('applies a lowered override on top of the plan', async () => {
        await h.setLimitOverride(alice, { activeJobs: 1 });
        await admit(alice, 'key-00000001');
        await expect(admit(alice, 'key-00000002')).rejects.toMatchObject({ kind: 'active_jobs' });
        // Other users keep the plan default.
        await admit(bob, 'key-00000001');
        await expect(admit(bob, 'key-00000002')).resolves.toMatchObject({ replayed: false });
      });

      it('lets only one of many concurrent requests take the last slot', async () => {
        await h.setLimitOverride(alice, { ...WIDE, activeJobs: 2 });
        const outcomes = await Promise.allSettled(
          Array.from({ length: 6 }, (_, i) => admit(alice, `key-0000000${i}`)),
        );
        expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
        expect(
          outcomes
            .filter((o): o is PromiseRejectedResult => o.status === 'rejected')
            .every((o) => o.reason instanceof QuotaExceededError),
        ).toBe(true);
        expect((await h.store.jobs.list(alice, null, 10)).jobs).toHaveLength(2);
      });

      it('creates one job when the same key is sent concurrently', async () => {
        const results = await Promise.all(
          Array.from({ length: 4 }, () => admit(alice, 'key-00000001')),
        );
        expect(new Set(results.map((r) => r.job.jobId)).size).toBe(1);
        expect(results.filter((r) => !r.replayed)).toHaveLength(1);
        expect(await pending()).toHaveLength(1);
      });

      it('enforces the account-wide daily ceiling across users', async () => {
        h = await make({ accountDailyCeilingMicroUsd: 100_000 });
        // A day of its own, because the account counter is shared by every test on a shared table.
        const day = new Date(
          Date.UTC(
            2100 + Math.floor(Math.random() * 800),
            Math.floor(Math.random() * 12),
            1 + Math.floor(Math.random() * 28),
            12,
          ),
        );
        await admit(alice, 'key-00000001', 'h1', day);
        await admit(bob, 'key-00000001', 'h2', day);
        const carol = randomUUID();
        await expect(
          h.store.jobs.admit({
            ownerId: carol,
            plan: FREE,
            pipelineReleaseId: 'v1',
            idempotencyKey: 'key-00000001',
            requestHash: 'h3',
            request: request('key-00000001'),
            now: day,
            deadlineAt: new Date(day.getTime() + 600_000),
          }),
        ).rejects.toMatchObject({ kind: 'account_ceiling' });
      });

      it('resolves a higher-tier plan from the plan table', async () => {
        const plus = 'plus' as Plan;
        h = await make({
          planLimits: {
            free: {
              jobsPerDay: 20,
              activeJobs: 2,
              dailySpendMicroUsd: 1_000_000,
              jobCapMicroUsd: 50_000,
            },
            plus: {
              jobsPerDay: 100,
              activeJobs: 5,
              dailySpendMicroUsd: 5_000_000,
              jobCapMicroUsd: 200_000,
            },
          },
        });
        const admitPlus = (key: string) =>
          h.store.jobs.admit({
            ownerId: alice,
            plan: plus,
            pipelineReleaseId: 'v1',
            idempotencyKey: key,
            requestHash: key,
            request: request(key),
            now: NOW,
            deadlineAt: DEADLINE,
          });
        const first = await admitPlus('key-00000001');
        // The per-job cap is the lower of the plan cap and the 0.10 planning budget.
        expect(first.job.budgetCapMicroUsd).toBe(100_000);
        for (let i = 2; i <= 5; i += 1) {
          await admitPlus(`key-0000000${i}`);
        }
        await expect(admitPlus('key-00000006')).rejects.toMatchObject({ kind: 'active_jobs' });
      });

      it('retries a failed job under the limits and emits an event', async () => {
        const failed = await admit(alice, 'key-00000001');
        await h.failJob(alice, failed.job.jobId);
        const later = new Date(NOW.getTime() + 1000);
        const retried = await h.store.jobs.retry(alice, failed.job.jobId, later);
        expect(retried).toMatchObject({
          status: 'queued',
          stage: 'admission',
          error: null,
          spendReservedMicroUsd: 50_000,
        });
        expect((await pending()).map((e) => e.type)).toEqual(['job.admitted', 'job.retried']);
        // Retrying a job that is already queued changes nothing.
        expect(await h.store.jobs.retry(alice, failed.job.jobId, NOW)).toMatchObject({
          status: 'queued',
        });
        expect(await pending()).toHaveLength(2);
      });

      it('refuses to retry when the user has no free slot', async () => {
        const failed = await admit(alice, 'key-00000001');
        await h.failJob(alice, failed.job.jobId);
        await admit(alice, 'key-00000002');
        await admit(alice, 'key-00000003');
        await expect(h.store.jobs.retry(alice, failed.job.jobId, NOW)).rejects.toMatchObject({
          kind: 'active_jobs',
        });
        expect(await h.store.jobs.get(alice, failed.job.jobId)).toMatchObject({ status: 'failed' });
      });

      it('deletes a job, frees its key and releases a held slot', async () => {
        const one = await admit(alice, 'key-00000001');
        await admit(alice, 'key-00000002');
        expect(await h.store.jobs.delete(alice, one.job.jobId)).toBe(true);
        expect(await h.store.jobs.get(alice, one.job.jobId)).toBeNull();
        expect(await h.store.jobs.input(alice, one.job.jobId)).toBeNull();
        expect(await h.store.jobs.findByIdempotencyKey(alice, 'key-00000001')).toBeNull();
        expect(await h.store.jobs.delete(alice, one.job.jobId)).toBe(false);
        await expect(admit(alice, 'key-00000003')).resolves.toMatchObject({ replayed: false });
      });

      it('lists newest first with a cursor, and only the caller’s jobs', async () => {
        await h.setLimitOverride(alice, WIDE);
        const times = [0, 1, 2, 3, 4].map((i) => new Date(NOW.getTime() + i * 1000));
        const ids: string[] = [];
        for (const [i, at] of times.entries()) {
          ids.push((await admit(alice, `key-0000000${i}`, `h${i}`, at)).job.jobId);
        }
        await admit(bob, 'key-00000009');
        const first = await h.store.jobs.list(alice, null, 2);
        expect(first.jobs.map((j) => j.jobId)).toEqual([ids[4], ids[3]]);
        expect(first.nextCursor).not.toBeNull();
        const second = await h.store.jobs.list(alice, first.nextCursor, 2);
        expect(second.jobs.map((j) => j.jobId)).toEqual([ids[2], ids[1]]);
        const third = await h.store.jobs.list(alice, second.nextCursor, 2);
        expect(third.jobs.map((j) => j.jobId)).toEqual([ids[0]]);
        expect(third.nextCursor).toBeNull();
        expect((await h.store.jobs.list(bob, null, 10)).jobs).toHaveLength(1);
      });

      it('rejects a cursor it did not issue', async () => {
        await expect(h.store.jobs.list(alice, 'bm90LWEtY3Vyc29y', 5)).rejects.toBeInstanceOf(
          InvalidCursorError,
        );
      });

      it('shows another user’s job as missing on every access pattern', async () => {
        const { job } = await admit(alice, 'key-00000001');
        expect(await h.store.jobs.get(bob, job.jobId)).toBeNull();
        expect(await h.store.jobs.cancel(bob, job.jobId, NOW)).toBeNull();
        expect(await h.store.jobs.retry(bob, job.jobId, NOW)).toBeNull();
        expect(await h.store.jobs.delete(bob, job.jobId)).toBe(false);
        expect((await h.store.jobs.list(bob, null, 10)).jobs).toEqual([]);
        // Nothing of Alice's changed.
        expect(await h.store.jobs.get(alice, job.jobId)).toMatchObject({ status: 'queued' });
      });

      it('dispatches each outbox event once', async () => {
        await admit(alice, 'key-00000001');
        const [event] = await pending();
        expect(event).toBeDefined();
        await h.store.outbox.markDispatched(event!, NOW);
        expect(await pending()).toEqual([]);
        await h.store.outbox.markDispatched(event!, NOW);
        expect(await pending()).toEqual([]);
      });
    });

    describe('execution', () => {
      const LEASE_MS = 60_000;
      const later = (ms: number) => new Date(NOW.getTime() + ms);

      beforeEach(async () => {
        h = await make({});
      });

      const claimed = async (owner: string, jobId: string, at = NOW) => {
        const result = await h.store.execution.claim(owner, jobId, at, LEASE_MS);
        if (result.kind !== 'claimed') throw new Error(`not claimed: ${result.reason}`);
        return result;
      };

      it('lets one worker claim a job and recovers it once the lease expires', async () => {
        const { job } = await admit(alice, 'key-00000001');
        const first = await claimed(alice, job.jobId);
        expect(first.lease.fence).toBe(1);
        expect(first.job).toMatchObject({ status: 'running' });
        expect(await h.store.execution.claim(alice, job.jobId, later(1_000), LEASE_MS)).toEqual({
          kind: 'skipped',
          reason: 'leased',
        });
        const second = await claimed(alice, job.jobId, later(LEASE_MS + 1));
        expect(second.lease.fence).toBe(2);
      });

      it('grants one claim among concurrent workers', async () => {
        const { job } = await admit(alice, 'key-00000001');
        const results = await Promise.all(
          Array.from({ length: 5 }, () => h.store.execution.claim(alice, job.jobId, NOW, LEASE_MS)),
        );
        expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1);
      });

      it('refuses a stale worker once a newer lease exists, and publishes once', async () => {
        const { job } = await admit(alice, 'key-00000001');
        const old = await claimed(alice, job.jobId);
        const fresh = await claimed(alice, job.jobId, later(LEASE_MS + 1));
        const now = later(LEASE_MS + 2);
        const settle = { spendCommittedMicroUsd: 0 };
        expect(await h.store.execution.checkpoint(old.lease, 'inference', { id: 'a' }, now)).toBe(
          'stale',
        );
        expect(await h.store.execution.succeed(old.lease, { by: 'old' }, settle, now)).toBe(
          'stale',
        );
        expect(await h.store.execution.fail(old.lease, expiredError(job.jobId), settle, now)).toBe(
          'stale',
        );
        expect(await h.store.execution.succeed(fresh.lease, { by: 'new' }, settle, now)).toBe(
          'applied',
        );
        expect(await h.store.jobs.get(alice, job.jobId)).toMatchObject({
          status: 'succeeded',
          result: { by: 'new' },
        });
        // The old worker cannot overwrite the published result afterwards either.
        expect(await h.store.execution.succeed(old.lease, { by: 'old' }, settle, now)).toBe(
          'stale',
        );
        expect((await h.store.jobs.get(alice, job.jobId))?.result).toEqual({ by: 'new' });
      });

      it('lets a worker whose lease expired finish if nobody took over', async () => {
        const { job } = await admit(alice, 'key-00000001');
        const lease = (await claimed(alice, job.jobId)).lease;
        expect(
          await h.store.execution.succeed(
            lease,
            { ok: 1 },
            { spendCommittedMicroUsd: 0 },
            later(LEASE_MS * 2),
          ),
        ).toBe('applied');
      });

      it('applies a repeated completion by the same lease once, freeing the slot once', async () => {
        const a = await admit(alice, 'key-00000001');
        await admit(alice, 'key-00000002');
        const { lease } = await claimed(alice, a.job.jobId);
        const settle = { spendCommittedMicroUsd: 0 };
        expect(await h.store.execution.succeed(lease, { n: 1 }, settle, NOW)).toBe('applied');
        expect(await h.store.execution.succeed(lease, { n: 1 }, settle, NOW)).toBe('applied');
        // Two slots in total: one is free again, and only one.
        await expect(admit(alice, 'key-00000003')).resolves.toMatchObject({ replayed: false });
        await expect(admit(alice, 'key-00000004')).rejects.toMatchObject({ kind: 'active_jobs' });
      });

      it('keeps what was spent and gives back the rest of the reservation', async () => {
        await h.setLimitOverride(alice, { ...WIDE, dailySpendMicroUsd: 100_000 });
        const a = await admit(alice, 'key-00000001');
        const b = await admit(alice, 'key-00000002');
        await expect(admit(alice, 'key-00000003')).rejects.toMatchObject({ kind: 'daily_spend' });
        const { lease } = await claimed(alice, a.job.jobId);
        await h.store.execution.succeed(lease, {}, { spendCommittedMicroUsd: 10_000 }, NOW);
        expect(await h.store.jobs.get(alice, a.job.jobId)).toMatchObject({
          spendReservedMicroUsd: 0,
          spendCommittedMicroUsd: 10_000,
        });
        // 10k spent + 50k still reserved for b leaves 40k: not enough for another 50k hold.
        await expect(admit(alice, 'key-00000003')).rejects.toMatchObject({ kind: 'daily_spend' });
        const second = await claimed(alice, b.job.jobId);
        await h.store.execution.succeed(second.lease, {}, { spendCommittedMicroUsd: 0 }, NOW);
        await expect(admit(alice, 'key-00000003')).resolves.toMatchObject({ replayed: false });
      });

      it('never keeps more than the job’s cap', async () => {
        const { job } = await admit(alice, 'key-00000001');
        const { lease } = await claimed(alice, job.jobId);
        await h.store.execution.succeed(lease, {}, { spendCommittedMicroUsd: 999_999 }, NOW);
        expect((await h.store.jobs.get(alice, job.jobId))?.spendCommittedMicroUsd).toBe(50_000);
      });

      it('stops a worker whose job was cancelled or deleted', async () => {
        const a = await admit(alice, 'key-00000001');
        const b = await admit(alice, 'key-00000002');
        const first = await claimed(alice, a.job.jobId);
        const second = await claimed(alice, b.job.jobId);
        const settle = { spendCommittedMicroUsd: 0 };
        await h.store.jobs.cancel(alice, a.job.jobId, NOW);
        await h.store.jobs.delete(alice, b.job.jobId);
        expect(await h.store.execution.succeed(first.lease, {}, settle, NOW)).toBe('stale');
        expect(await h.store.execution.succeed(second.lease, {}, settle, NOW)).toBe('stale');
        expect(await h.store.jobs.get(alice, a.job.jobId)).toMatchObject({ status: 'cancelled' });
        expect(await h.store.jobs.get(alice, b.job.jobId)).toBeNull();
        // Cancelling and deleting released both slots exactly once.
        await admit(alice, 'key-00000003');
        await admit(alice, 'key-00000004');
        await expect(admit(alice, 'key-00000005')).rejects.toMatchObject({ kind: 'active_jobs' });
      });

      it('remembers provider ids and the stage across a crash', async () => {
        const { job } = await admit(alice, 'key-00000001');
        const first = await claimed(alice, job.jobId);
        expect(
          await h.store.execution.checkpoint(first.lease, 'ocr', { textractJobId: 't-1' }, NOW),
        ).toBe('applied');
        const again = await claimed(alice, job.jobId, later(LEASE_MS + 1));
        expect(again.job).toMatchObject({ stage: 'ocr' });
        expect(again.job.exec.checkpoints.ocr).toEqual({ textractJobId: 't-1' });
      });

      it('parks a retry until it is due, counting the attempt', async () => {
        const { job } = await admit(alice, 'key-00000001');
        const { lease } = await claimed(alice, job.jobId);
        const due = later(5_000);
        expect(await h.store.execution.retryLater(lease, 'inference', due, NOW)).toBe('applied');
        const waiting = await h.store.jobs.get(alice, job.jobId);
        expect(waiting).toMatchObject({ status: 'retry_wait', stage: 'inference' });
        expect(waiting?.exec.stepAttempts).toEqual({ inference: 1 });
        expect(waiting?.exec.availableAt).toEqual(due);

        // The retry event is not dispatchable before it is due.
        const types = async (at: Date) =>
          (await h.store.outbox.pending(1000, at))
            .filter((e) => e.ownerId === alice)
            .map((e) => e.type);
        expect(await types(NOW)).not.toContain('job.retry');
        expect(await types(due)).toContain('job.retry');

        expect(await h.store.execution.claim(alice, job.jobId, later(1_000), LEASE_MS)).toEqual({
          kind: 'skipped',
          reason: 'not_due',
        });
        const next = await claimed(alice, job.jobId, due);
        // Every claim and every handoff (retry, wait) raises the fence.
        expect(next.lease.fence).toBe(3);
        expect(await h.store.execution.retryLater(lease, 'inference', due, due)).toBe('stale');
      });

      it('parks a job on an external operation without a lease, and wakes it on completion', async () => {
        const { job } = await admit(alice, 'key-00000001');
        const { lease } = await claimed(alice, job.jobId);
        expect(await h.store.execution.waitExternal(lease, 'ocr-1', NOW)).toBe('applied');
        expect(await h.store.jobs.get(alice, job.jobId)).toMatchObject({
          status: 'waiting_external',
        });
        expect(await h.store.execution.claim(alice, job.jobId, later(1_000), LEASE_MS)).toEqual({
          kind: 'skipped',
          reason: 'waiting',
        });
        expect(await h.store.execution.succeed(lease, {}, { spendCommittedMicroUsd: 0 }, NOW)).toBe(
          'stale',
        );
        expect(await h.store.execution.resume(alice, job.jobId, 'wrong', NOW)).toBe(false);
        expect(await h.store.execution.resume(bob, job.jobId, 'ocr-1', NOW)).toBe(false);
        expect(await h.store.execution.resume(alice, job.jobId, 'ocr-1', NOW)).toBe(true);
        expect(await h.store.execution.resume(alice, job.jobId, 'ocr-1', NOW)).toBe(false);
        expect((await pending()).map((e) => e.type)).toContain('job.resume');
        expect((await claimed(alice, job.jobId, later(1_000))).lease.fence).toBe(3);
      });

      describe('keeps spend from the ledger on every way a job ends', () => {
        // Each job reserves its 50_000 cap; the limit fits two reservations. A job that ends after
        // a 30_000 call must keep the 30_000, so two more reservations no longer fit.
        const paid = async () => {
          await h.setLimitOverride(alice, { ...WIDE, dailySpendMicroUsd: 100_000 });
          const { job } = await admit(alice, 'key-00000001');
          const { lease } = await claimed(alice, job.jobId);
          await h.store.execution.checkpoint(lease, 'inference', { 'spend.1': '30000:30000' }, NOW);
          return { job, lease };
        };
        const kept = async (jobId: string) => {
          expect(await h.store.jobs.get(alice, jobId)).toMatchObject({
            spendReservedMicroUsd: 0,
            spendCommittedMicroUsd: 30_000,
          });
          await admit(alice, 'key-00000002');
          await expect(admit(alice, 'key-00000003')).rejects.toMatchObject({ kind: 'daily_spend' });
        };

        it('on cancel', async () => {
          const { job } = await paid();
          await h.store.jobs.cancel(alice, job.jobId, NOW);
          await kept(job.jobId);
        });

        it('on expiry', async () => {
          const { job } = await paid();
          await h.store.execution.claim(alice, job.jobId, later(11 * 60_000), LEASE_MS);
          await kept(job.jobId);
        });

        it('on a failure that reports no spend', async () => {
          const { job, lease } = await paid();
          const error = expiredError(job.jobId, 'internal_error');
          await h.store.execution.fail(lease, error, { spendCommittedMicroUsd: 0 }, NOW);
          await kept(job.jobId);
        });

        it('on delete', async () => {
          const { job } = await paid();
          await h.store.jobs.delete(alice, job.jobId);
          await admit(alice, 'key-00000002');
          await expect(admit(alice, 'key-00000003')).rejects.toMatchObject({ kind: 'daily_spend' });
        });
      });

      it('expires a job claimed after its deadline and frees its slot', async () => {
        const a = await admit(alice, 'key-00000001');
        await admit(alice, 'key-00000002');
        const result = await h.store.execution.claim(
          alice,
          a.job.jobId,
          later(11 * 60_000),
          LEASE_MS,
        );
        expect(result).toEqual({ kind: 'skipped', reason: 'expired' });
        expect(await h.store.jobs.get(alice, a.job.jobId)).toMatchObject({
          status: 'expired',
          error: { code: 'deadline_exceeded' },
          spendReservedMicroUsd: 0,
        });
        await expect(admit(alice, 'key-00000003')).resolves.toMatchObject({ replayed: false });
      });

      it('publishes nothing from a worker that finishes after the deadline', async () => {
        const a = await admit(alice, 'key-00000001');
        const { lease } = await claimed(alice, a.job.jobId);
        const result = await h.store.execution.succeed(
          lease,
          { n: 1 },
          { spendCommittedMicroUsd: 0 },
          later(11 * 60_000),
        );
        expect(result).toBe('stale');
        expect(await h.store.jobs.get(alice, a.job.jobId)).toMatchObject({
          status: 'expired',
          error: { code: 'deadline_exceeded' },
          spendReservedMicroUsd: 0,
        });
      });

      it('counts a lapsed lease as an attempt and stops a job that keeps killing its worker', async () => {
        const a = await admit(alice, 'key-00000001');
        let t = 0;
        let outcome = await h.store.execution.claim(alice, a.job.jobId, later(t), LEASE_MS);
        for (let crash = 1; crash <= 3; crash += 1) {
          expect(outcome.kind).toBe('claimed');
          t += LEASE_MS + 1_000; // the worker died; the lease lapses
          outcome = await h.store.execution.claim(alice, a.job.jobId, later(t), LEASE_MS);
        }
        expect(outcome).toEqual({ kind: 'skipped', reason: 'terminal' });
        expect(await h.store.jobs.get(alice, a.job.jobId)).toMatchObject({
          status: 'failed',
          error: { code: 'internal_error', retryable: true },
          spendReservedMicroUsd: 0,
        });
      });

      it('ends a stuck job visibly and keeps it retryable by its owner', async () => {
        const { job } = await admit(alice, 'key-00000001');
        const { lease } = await claimed(alice, job.jobId);
        const error = expiredError(job.jobId, 'internal_error');
        const dead = later(LEASE_MS + 1_000);
        // A worker under a live lease owns the job; a lapsed lease does not.
        expect(await h.store.execution.abandon(alice, job.jobId, error, NOW)).toBe('stale');
        expect(await h.store.execution.abandon(bob, job.jobId, error, dead)).toBe('stale');
        expect(await h.store.execution.abandon(alice, job.jobId, error, dead)).toBe('applied');
        expect(await h.store.execution.abandon(alice, job.jobId, error, dead)).toBe('stale');
        expect(await h.store.execution.succeed(lease, {}, { spendCommittedMicroUsd: 0 }, NOW)).toBe(
          'stale',
        );
        expect(await h.store.jobs.get(alice, job.jobId)).toMatchObject({
          status: 'failed',
          error: { code: 'internal_error' },
        });
        expect(await h.store.jobs.retry(alice, job.jobId, NOW)).toMatchObject({ status: 'queued' });
      });

      it('resets step attempts on an owner retry but keeps the job’s identity', async () => {
        const { job } = await admit(alice, 'key-00000001');
        const { lease } = await claimed(alice, job.jobId);
        await h.store.execution.retryLater(lease, 'inference', later(1_000), NOW);
        const next = await claimed(alice, job.jobId, later(1_000));
        await h.store.execution.fail(
          next.lease,
          expiredError(job.jobId, 'dependency_unavailable'),
          { spendCommittedMicroUsd: 0 },
          later(1_000),
        );
        const retried = await h.store.jobs.retry(alice, job.jobId, later(2_000));
        expect(retried).toMatchObject({ jobId: job.jobId, idempotencyKey: 'key-00000001' });
        expect(retried?.exec.stepAttempts).toEqual({});
        expect(retried?.exec.pipelineReleaseId).toBe('v1');
      });

      it('lists jobs for the reconciler only when they are due, and acts on them', async () => {
        const live = await admit(alice, 'key-00000001');
        const done = await admit(alice, 'key-00000002');
        const { lease } = await claimed(alice, done.job.jobId);
        await h.store.execution.succeed(lease, {}, { spendCommittedMicroUsd: 0 }, NOW);

        const mine = async (at: Date) =>
          (await h.store.execution.due(at, 1000))
            .filter((d) => d.ownerId === alice)
            .map((d) => d.jobId);
        expect(await mine(NOW)).toEqual([]);
        // Admitted work that should have started by now is due.
        expect(await mine(later(3 * 60_000))).toEqual([live.job.jobId]);

        expect(await h.store.execution.reconcile(alice, live.job.jobId, later(3 * 60_000))).toBe(
          'requeued',
        );
        expect((await pending()).filter((e) => e.type === 'job.requeue')).toHaveLength(1);
        // Looked at, so not due again until another grace has passed.
        expect(await mine(later(3 * 60_000 + 1_000))).toEqual([]);

        expect(await h.store.execution.reconcile(alice, live.job.jobId, later(11 * 60_000))).toBe(
          'expired',
        );
        expect(await h.store.jobs.get(alice, live.job.jobId)).toMatchObject({ status: 'expired' });
        expect(await h.store.execution.reconcile(alice, live.job.jobId, later(12 * 60_000))).toBe(
          'settled',
        );
        expect(await h.store.execution.reconcile(bob, live.job.jobId, later(12 * 60_000))).toBe(
          'missing',
        );
      });

      it('finds a crashed worker’s job when its lease runs out', async () => {
        const { job } = await admit(alice, 'key-00000001');
        await claimed(alice, job.jobId);
        const mine = async (at: Date) =>
          (await h.store.execution.due(at, 1000))
            .filter((d) => d.ownerId === alice)
            .map((d) => d.jobId);
        expect(await mine(later(LEASE_MS - 1_000))).toEqual([]);
        expect(await mine(later(LEASE_MS + 1_000))).toEqual([job.jobId]);
      });

      it('shows nothing of another user’s job to claim', async () => {
        const { job } = await admit(alice, 'key-00000001');
        expect(await h.store.execution.claim(bob, job.jobId, NOW, LEASE_MS)).toEqual({
          kind: 'skipped',
          reason: 'missing',
        });
        expect(await h.store.jobs.get(alice, job.jobId)).toMatchObject({ status: 'queued' });
      });
    });

    describe('sessions', () => {
      const create = (owner: string, key: string, hash = `hash-${key}`) =>
        h.store.sessions.create({
          ownerId: owner,
          clientRequestId: key,
          requestHash: hash,
          purpose: 'improve',
          context: context(),
          now: NOW,
        });

      beforeEach(async () => {
        h = await make({});
      });

      it('creates once per key and rejects a changed request', async () => {
        const first = await create(alice, 'session-0001');
        expect(first.replayed).toBe(false);
        expect(first.session.latestContext.sessionId).toBe(first.session.sessionId);
        const again = await create(alice, 'session-0001');
        expect(again.replayed).toBe(true);
        expect(again.session.sessionId).toBe(first.session.sessionId);
        await expect(create(alice, 'session-0001', 'other')).rejects.toBeInstanceOf(
          IdempotencyConflictError,
        );
      });

      it('creates one session when the key is sent concurrently', async () => {
        const results = await Promise.all(
          Array.from({ length: 4 }, () => create(alice, 'session-0001')),
        );
        expect(new Set(results.map((r) => r.session.sessionId)).size).toBe(1);
      });

      it('hides a session from other users', async () => {
        const { session } = await create(alice, 'session-0001');
        const base = session.latestContext.contextRevisionId;
        expect(await h.store.sessions.get(bob, session.sessionId)).toBeNull();
        expect(
          await h.store.sessions.addContext({
            ownerId: bob,
            sessionId: session.sessionId,
            baseContextRevisionId: base,
            context: context(),
            now: NOW,
          }),
        ).toBeNull();
        expect(await h.store.sessions.delete(bob, session.sessionId)).toBe(false);
        expect((await h.store.sessions.get(alice, session.sessionId))?.latestContext).toEqual(
          session.latestContext,
        );
      });

      it('advances the context only from the latest revision', async () => {
        const { session } = await create(alice, 'session-0001');
        const base = session.latestContext.contextRevisionId;
        const next = await h.store.sessions.addContext({
          ownerId: alice,
          sessionId: session.sessionId,
          baseContextRevisionId: base,
          context: { ...context(), contextHash: 'c'.repeat(64) },
          now: NOW,
        });
        expect(next).toMatchObject({ contextHash: 'c'.repeat(64) });
        expect(
          await h.store.sessions.addContext({
            ownerId: alice,
            sessionId: session.sessionId,
            baseContextRevisionId: base,
            context: context(),
            now: NOW,
          }),
        ).toBe('stale');
      });

      it('stores question sets under the session’s owner and folds answers into a new revision', async () => {
        const { session } = await create(alice, 'session-0001');
        const set = {
          questionSetId: randomUUID(),
          sessionId: session.sessionId,
          round: 1,
          questions: [],
          sourceHash: 'a'.repeat(64),
          jobDescriptionHash: null,
          jobId: null,
        };
        expect(await h.store.sessions.saveQuestionSet(bob, set, NOW)).toBeNull();
        expect(await h.store.sessions.saveQuestionSet(alice, set, NOW)).toEqual(set);
        expect(
          await h.store.sessions.getQuestionSet(alice, session.sessionId, set.questionSetId),
        ).toEqual(set);
        expect(
          await h.store.sessions.getQuestionSet(bob, session.sessionId, set.questionSetId),
        ).toBeNull();
        expect(
          await h.store.sessions.getQuestionSet(alice, randomUUID(), set.questionSetId),
        ).toBeNull();

        const base = session.latestContext.contextRevisionId;
        const answered = await h.store.sessions.addAnswers({
          ownerId: alice,
          sessionId: session.sessionId,
          baseContextRevisionId: base,
          questionSetId: set.questionSetId,
          answers: [],
          answersHash: 'd'.repeat(64),
          now: NOW,
        });
        expect(answered).toMatchObject({ answerRevisionId: expect.any(String) });
        expect(answered).not.toBe('stale');
        expect(
          await h.store.sessions.addAnswers({
            ownerId: alice,
            sessionId: session.sessionId,
            baseContextRevisionId: base,
            questionSetId: set.questionSetId,
            answers: [],
            answersHash: 'd'.repeat(64),
            now: NOW,
          }),
        ).toBe('stale');
      });

      it('keeps each revision’s content and the answers given up to it', async () => {
        const { session } = await create(alice, 'session-0001');
        const first = session.latestContext;
        const ctx = await h.store.sessions.context(
          alice,
          session.sessionId,
          first.contextRevisionId,
        );
        expect(ctx).toMatchObject({
          revision: first,
          source: {},
          jobDescription: null,
          answers: [],
        });
        expect(
          await h.store.sessions.context(bob, session.sessionId, first.contextRevisionId),
        ).toBeNull();
        expect(await h.store.sessions.context(alice, session.sessionId, randomUUID())).toBeNull();

        const set = h.store.sessions.saveQuestionSet(
          alice,
          {
            questionSetId: randomUUID(),
            sessionId: session.sessionId,
            round: 1,
            questions: [],
            sourceHash: first.sourceHash,
            jobDescriptionHash: null,
            jobId: null,
          },
          NOW,
        );
        const saved = (await set)!;
        const answers = [{ questionId: 'q1', status: 'skipped' as const }];
        const answered = await h.store.sessions.addAnswers({
          ownerId: alice,
          sessionId: session.sessionId,
          baseContextRevisionId: first.contextRevisionId,
          questionSetId: saved.questionSetId,
          answers,
          answersHash: 'd'.repeat(64),
          now: new Date(NOW.getTime() + 1_000),
        });
        if (!answered || answered === 'stale') throw new Error('not answered');
        const next = await h.store.sessions.context(
          alice,
          session.sessionId,
          answered.contextRevisionId,
        );
        expect(next).toMatchObject({
          revision: answered,
          source: {},
          questionSets: [expect.objectContaining({ questionSetId: saved.questionSetId })],
          answers: [expect.objectContaining({ questionSetId: saved.questionSetId, answers })],
        });
        // The earlier revision does not see answers given after it.
        expect(
          (await h.store.sessions.context(alice, session.sessionId, first.contextRevisionId))
            ?.answers,
        ).toEqual([]);
      });

      describe('question rounds', () => {
        const ask = (
          owner: string,
          sessionId: string,
          contextRevisionId: string,
          key: string,
          round: { round: number; slots: number; replaces: string | null },
        ) =>
          h.store.jobs.admit({
            ownerId: owner,
            plan: FREE,
            pipelineReleaseId: 'v1',
            idempotencyKey: key,
            requestHash: `hash-${key}`,
            request: {
              schemaVersion: '1.0',
              clientRequestId: key,
              operation: 'generate_questions',
              sessionId,
              contextRevisionId,
              parentJobId: null,
              input: { analysisJobId: null, round: round.round, maxQuestions: round.slots },
            } as unknown as CreateJobRequest,
            now: NOW,
            deadlineAt: DEADLINE,
            questionRound: round,
          });
        const issue = (sessionId: string, jobId: string, round: number, count: number) =>
          h.store.sessions.issueQuestionSet(
            alice,
            {
              questionSetId: randomUUID(),
              sessionId,
              round,
              questions: Array.from({ length: count }, (_, i) => ({
                id: `q${round}-${i}`,
                topicKey: `topic-${round}-${i}`,
                prompt: 'p',
                guidance: null,
                reason: 'r',
                targetSection: null,
                targetEntityId: null,
                requirementIds: [],
              })),
              sourceHash: 'a'.repeat(64),
              jobDescriptionHash: null,
              jobId,
            },
            NOW,
          );

        beforeEach(async () => {
          await h.setLimitOverride(alice, WIDE);
        });

        it('takes rounds in order, one job each, and commits what a set issues', async () => {
          const { session } = await create(alice, 'session-0001');
          const ctx = session.latestContext.contextRevisionId;
          const one = { round: 1, slots: 5, replaces: null };
          const { job } = await ask(alice, session.sessionId, ctx, 'key-00000001', one);
          await expect(
            ask(alice, session.sessionId, ctx, 'key-00000002', one),
          ).rejects.toBeInstanceOf(QuestionRoundTakenError);
          // Round 2 waits for round 1's set.
          await expect(
            ask(alice, session.sessionId, ctx, 'key-00000003', { ...one, round: 2 }),
          ).rejects.toBeInstanceOf(QuestionRoundTakenError);
          // Another user cannot take a round of this session.
          await expect(
            ask(bob, session.sessionId, ctx, 'key-00000004', one),
          ).rejects.toBeInstanceOf(QuestionRoundTakenError);

          expect(await issue(session.sessionId, randomUUID(), 1, 3)).toBe('stale');
          expect(await issue(session.sessionId, job.jobId, 1, 4)).toBe('issued');
          expect(await h.store.sessions.get(alice, session.sessionId)).toMatchObject({
            questionRoundsUsed: 1,
            questionsIssued: 4,
          });
          // Six more would pass the ten-question session limit; five fit.
          await expect(
            ask(alice, session.sessionId, ctx, 'key-00000005', {
              round: 2,
              slots: 7,
              replaces: null,
            }),
          ).rejects.toBeInstanceOf(QuestionRoundTakenError);
          const two = await ask(alice, session.sessionId, ctx, 'key-00000006', {
            round: 2,
            slots: 5,
            replaces: null,
          });
          expect(await issue(session.sessionId, two.job.jobId, 2, 5)).toBe('issued');
          expect(await h.store.sessions.get(alice, session.sessionId)).toMatchObject({
            questionRoundsUsed: 2,
            questionsIssued: 9,
          });
        });

        it('lets a new job take a round whose job ended without a set', async () => {
          const { session } = await create(alice, 'session-0001');
          const ctx = session.latestContext.contextRevisionId;
          const one = { round: 1, slots: 5, replaces: null };
          const first = await ask(alice, session.sessionId, ctx, 'key-00000001', one);
          // Still running: it cannot be replaced.
          await expect(
            ask(alice, session.sessionId, ctx, 'key-00000002', {
              ...one,
              replaces: first.job.jobId,
            }),
          ).rejects.toBeInstanceOf(QuestionRoundTakenError);
          await h.failJob(alice, first.job.jobId);
          await expect(
            ask(alice, session.sessionId, ctx, 'key-00000003', one),
          ).rejects.toBeInstanceOf(QuestionRoundTakenError);
          const second = await ask(alice, session.sessionId, ctx, 'key-00000004', {
            ...one,
            replaces: first.job.jobId,
          });
          // The failed job can no longer issue; the new holder can.
          expect(await issue(session.sessionId, first.job.jobId, 1, 2)).toBe('stale');
          expect(await issue(session.sessionId, second.job.jobId, 1, 2)).toBe('issued');
        });
      });

      it('deletes the session and what hangs off it', async () => {
        const { session } = await create(alice, 'session-0001');
        const set = {
          questionSetId: randomUUID(),
          sessionId: session.sessionId,
          round: 1,
          questions: [],
          sourceHash: 'a'.repeat(64),
          jobDescriptionHash: null,
          jobId: null,
        };
        await h.store.sessions.saveQuestionSet(alice, set, NOW);
        expect(await h.store.sessions.delete(alice, session.sessionId)).toBe(true);
        expect(await h.store.sessions.get(alice, session.sessionId)).toBeNull();
        expect(
          await h.store.sessions.getQuestionSet(alice, session.sessionId, set.questionSetId),
        ).toBeNull();
        expect(await h.store.sessions.delete(alice, session.sessionId)).toBe(false);
        // The key is free again.
        expect((await create(alice, 'session-0001')).replayed).toBe(false);
      });
    });

    describe('documents', () => {
      const body = {
        contentType: 'application/pdf',
        sizeBytes: 1234,
        sha256: 'e'.repeat(64),
      } as Parameters<Store['documents']['create']>[1];

      beforeEach(async () => {
        h = await make({});
      });

      const key = (owner: string) => `pending/${owner}/${randomUUID()}`;
      const pin = { versionId: 'v-1' };
      const artifact = {
        key: 'results/o/documents/d/text.json',
        versionId: 'a-1',
        sha256: 'f'.repeat(64),
        chars: 10,
        extractorVersion: 'docx-1',
        method: 'docx' as const,
      };

      it('creates, completes once and deletes, for the owner only', async () => {
        const doc = await h.store.documents.create(alice, body, key(alice), NOW);
        expect(doc).toMatchObject({
          status: 'awaiting_upload',
          ownerId: alice,
          ocrPages: [],
          objectVersionId: null,
        });
        expect(doc.expiresAt).toEqual(new Date(NOW.getTime() + 24 * 60 * 60 * 1000));
        expect(await h.store.documents.get(bob, doc.documentId)).toBeNull();
        expect(await h.store.documents.complete(bob, doc.documentId, pin, NOW)).toBeNull();
        expect(await h.store.documents.get(alice, doc.documentId)).toMatchObject({
          status: 'awaiting_upload',
        });

        const completed = await h.store.documents.complete(alice, doc.documentId, pin, NOW);
        expect(completed?.document).toMatchObject({
          status: 'validating',
          objectVersionId: 'v-1',
        });
        expect(completed?.document.expiresAt).toEqual(
          new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
        );
        expect(completed?.event).toMatchObject({
          type: 'document.validate',
          ownerId: alice,
          jobId: doc.documentId,
          operation: null,
        });
        // A second completion neither changes the pinned version nor queues more work.
        const again = await h.store.documents.complete(
          alice,
          doc.documentId,
          { versionId: 'v-2' },
          NOW,
        );
        expect(again?.document).toMatchObject({ status: 'validating', objectVersionId: 'v-1' });
        expect(again?.event).toBeNull();
        const queued = (await h.store.outbox.pending(1_000, NOW)).filter(
          (event) => event.jobId === doc.documentId,
        );
        expect(queued).toHaveLength(1);

        expect(await h.store.documents.delete(bob, doc.documentId)).toBeNull();
        expect(await h.store.documents.delete(alice, doc.documentId)).toMatchObject({
          documentId: doc.documentId,
          objectKey: doc.objectKey,
        });
        expect(await h.store.documents.get(alice, doc.documentId)).toBeNull();
        expect(await h.store.documents.delete(alice, doc.documentId)).toBeNull();
      });

      it('finishes a validating document once, as ready or rejected', async () => {
        const ready = await h.store.documents.create(alice, body, key(alice), NOW);
        const outcome = {
          kind: 'ready' as const,
          pageCount: null,
          ocrPages: [],
          warnings: [{ code: 'docx_images_not_read', message: 'm' }],
          artifact,
        };
        // Not validating yet, or someone else's: nothing changes.
        expect(await h.store.documents.finish(alice, ready.documentId, outcome, NOW)).toBeNull();
        await h.store.documents.complete(alice, ready.documentId, pin, NOW);
        expect(await h.store.documents.finish(bob, ready.documentId, outcome, NOW)).toBeNull();
        expect(await h.store.documents.finish(alice, ready.documentId, outcome, NOW)).toMatchObject(
          {
            status: 'ready',
            artifact,
            warnings: outcome.warnings,
          },
        );
        expect(await h.store.documents.finish(alice, ready.documentId, outcome, NOW)).toBeNull();

        const bad = await h.store.documents.create(alice, body, key(alice), NOW);
        await h.store.documents.complete(alice, bad.documentId, pin, NOW);
        expect(
          await h.store.documents.finish(
            alice,
            bad.documentId,
            { kind: 'rejected', code: 'unusable_document', warnings: [] },
            NOW,
          ),
        ).toMatchObject({ status: 'rejected', rejectionCode: 'unusable_document' });
      });

      it('records OCR intent once and the provider job only for that intent', async () => {
        const doc = await h.store.documents.create(alice, body, key(alice), NOW);
        const ocr = { clientToken: 'tok-1', pages: 2 };
        // Not validating yet: nothing to record.
        expect(await h.store.documents.beginOcr(alice, doc.documentId, ocr)).toBe(false);
        await h.store.documents.complete(alice, doc.documentId, pin, NOW);
        expect(await h.store.documents.beginOcr(bob, doc.documentId, ocr)).toBe(false);
        expect(await h.store.documents.beginOcr(alice, doc.documentId, ocr)).toBe(true);
        expect(await h.store.documents.beginOcr(alice, doc.documentId, ocr)).toBe(false);
        expect(
          await h.store.documents.recordOcrJob(alice, doc.documentId, 'other-token', 'job-1'),
        ).toBe(false);
        expect(await h.store.documents.recordOcrJob(alice, doc.documentId, 'tok-1', 'job-1')).toBe(
          true,
        );
        expect(await h.store.documents.get(alice, doc.documentId)).toMatchObject({
          ocr: { state: 'started', textractJobId: 'job-1', clientToken: 'tok-1', pages: 2 },
        });
        expect(await h.store.documents.recordOcrJob(alice, doc.documentId, 'tok-1', 'job-2')).toBe(
          false,
        );
      });

      it('does not finish a document that was deleted meanwhile', async () => {
        const doc = await h.store.documents.create(alice, body, key(alice), NOW);
        await h.store.documents.complete(alice, doc.documentId, pin, NOW);
        await h.store.documents.delete(alice, doc.documentId);
        expect(
          await h.store.documents.finish(
            alice,
            doc.documentId,
            { kind: 'rejected', code: 'unusable_document', warnings: [] },
            NOW,
          ),
        ).toBeNull();
        expect(await h.store.documents.get(alice, doc.documentId)).toBeNull();
      });
    });
  });
}
