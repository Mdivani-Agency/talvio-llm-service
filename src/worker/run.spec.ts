import { randomUUID } from 'crypto';

import type { CreateJobRequest } from '@talvio/llm-contracts';

import { LEASE_MS, MAX_STEP_ATTEMPTS } from '../lib/execution';
import { createLogger } from '../lib/log';
import type { WorkMessage } from '../lib/queue';
import { createMemoryStore, type MemoryStore } from '../lib/store/memory';
import { TransientError, runJob, type Executor, type RunDeps } from './run';

const OWNER = randomUUID();
const START = new Date('2026-11-10T12:00:00.000Z');

const request = (key: string) =>
  ({
    schemaVersion: '1.0',
    clientRequestId: key,
    operation: 'parse_document',
    input: { kind: 'text', text: 'SECRET résumé text', extraction: null },
  }) as CreateJobRequest;

describe('runJob', () => {
  let store: MemoryStore;
  let clock: Date;
  let logs: string[];
  let jobId: string;

  const message = (): WorkMessage => ({
    v: 1,
    type: 'job.admitted',
    ownerId: OWNER,
    jobId,
    eventId: randomUUID(),
  });
  const deps = (executor?: Executor): RunDeps => ({
    store,
    executors: executor ? { parse_document: executor } : {},
    logger: createLogger('debug', (line) => logs.push(line)),
    now: () => clock,
    random: () => 0.5,
  });
  const tick = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  const job = async () => store.jobs.get(OWNER, jobId);

  beforeEach(async () => {
    store = createMemoryStore();
    clock = START;
    logs = [];
    const admitted = await store.jobs.admit({
      ownerId: OWNER,
      plan: 'free',
      pipelineReleaseId: 'v1',
      idempotencyKey: 'key-00000001',
      requestHash: 'h',
      request: request('key-00000001'),
      now: START,
      deadlineAt: new Date(START.getTime() + 600_000),
    });
    jobId = admitted.job.jobId;
  });

  it('publishes the result and keeps only what was spent', async () => {
    const executor = jest.fn<ReturnType<Executor>, Parameters<Executor>>(async () => ({
      kind: 'succeeded',
      result: { ok: true },
      spendMicroUsd: 12_000,
    }));
    expect(await runJob(deps(executor), message())).toBe('succeeded');
    expect(await job()).toMatchObject({
      status: 'succeeded',
      result: { ok: true },
      spendReservedMicroUsd: 0,
      spendCommittedMicroUsd: 12_000,
    });
    // A second delivery of the same message finds the job finished and does nothing.
    expect(await runJob(deps(executor), message())).toBe('skipped');
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('fails a job at once when this release has no executor for its operation', async () => {
    expect(await runJob(deps(), message())).toBe('failed');
    expect(await job()).toMatchObject({
      status: 'failed',
      error: { code: 'dependency_unavailable', retryable: true },
    });
    // The owner may retry it later, once the executor exists.
    expect(await store.jobs.retry(OWNER, jobId, clock)).toMatchObject({ status: 'queued' });
  });

  it('runs a duplicate delivery once while the first holds the lease', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const executor = jest.fn<ReturnType<Executor>, Parameters<Executor>>(async () => {
      await gate;
      return { kind: 'succeeded', result: 1, spendMicroUsd: 0 };
    });
    const first = runJob(deps(executor), message());
    await Promise.resolve();
    expect(await runJob(deps(executor), message())).toBe('skipped');
    release();
    expect(await first).toBe('succeeded');
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure with backoff, then fails visibly after the last attempt', async () => {
    const executor: Executor = async () => {
      throw new TransientError('inference');
    };
    for (let attempt = 1; attempt < MAX_STEP_ATTEMPTS; attempt += 1) {
      expect(await runJob(deps(executor), message())).toBe('retrying');
      const waiting = await job();
      expect(waiting).toMatchObject({ status: 'retry_wait', stage: 'inference' });
      expect(waiting?.exec.stepAttempts.inference).toBe(attempt);
      // Not before it is due.
      expect(await runJob(deps(executor), message())).toBe('skipped');
      tick(waiting!.exec.availableAt!.getTime() - clock.getTime());
    }
    expect(await runJob(deps(executor), message())).toBe('failed');
    expect(await job()).toMatchObject({
      status: 'failed',
      error: { code: 'dependency_unavailable', retryable: true },
      spendReservedMicroUsd: 0,
    });
  });

  it('treats an unexpected error as transient and never stores or logs its message', async () => {
    const executor: Executor = async () => {
      throw new Error('prompt contained SECRET résumé text');
    };
    expect(await runJob(deps(executor), message())).toBe('retrying');
    expect((await job())?.error).toBeNull();
    expect(logs.join('\n')).not.toContain('SECRET');
    expect(logs.join('\n')).toContain('"errorName":"Error"');
  });

  it('never schedules a retry past the deadline', async () => {
    tick(9 * 60_000 + 59_000);
    const executor: Executor = async () => {
      throw new TransientError('inference');
    };
    expect(await runJob(deps(executor), message())).toBe('retrying');
    const waiting = await job();
    expect(waiting?.exec.availableAt).toEqual(waiting?.deadlineAt);
    tick(2_000);
    expect(await runJob(deps(executor), message())).toBe('skipped');
    expect(await job()).toMatchObject({ status: 'expired' });
  });

  it('recovers a job whose worker crashed, and publishes once', async () => {
    // A worker claims the job and dies without finishing.
    await store.execution.claim(OWNER, jobId, clock, LEASE_MS);
    const executor = jest.fn<ReturnType<Executor>, Parameters<Executor>>(async () => ({
      kind: 'succeeded',
      result: 'done',
      spendMicroUsd: 0,
    }));
    expect(await runJob(deps(executor), message())).toBe('skipped');
    tick(LEASE_MS + 1);
    expect(await runJob(deps(executor), message())).toBe('succeeded');
    expect(await job()).toMatchObject({ status: 'succeeded', result: 'done' });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('resumes from a checkpoint instead of repeating the provider call', async () => {
    const provider = jest.fn();
    const executor: Executor = async ({ job: current, checkpoint }) => {
      const known = current.exec.checkpoints.ocr?.textractJobId;
      if (!known) {
        provider();
        await checkpoint('ocr', { textractJobId: 't-1' });
        throw new TransientError('ocr');
      }
      return { kind: 'succeeded', result: known, spendMicroUsd: 0 };
    };
    expect(await runJob(deps(executor), message())).toBe('retrying');
    tick(120_000);
    expect(await runJob(deps(executor), message())).toBe('succeeded');
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await job())?.result).toBe('t-1');
  });

  it('repeats a step after an ambiguous failure but publishes and settles once', async () => {
    const modelCall = jest.fn();
    const executor: Executor = async () => {
      modelCall();
      // The call may have succeeded; the worker cannot tell and is retried.
      if (modelCall.mock.calls.length === 1) throw new TransientError('inference');
      return { kind: 'succeeded', result: 'answer', spendMicroUsd: 8_000 };
    };
    expect(await runJob(deps(executor), message())).toBe('retrying');
    tick(120_000);
    expect(await runJob(deps(executor), message())).toBe('succeeded');
    expect(modelCall).toHaveBeenCalledTimes(2);
    expect(await job()).toMatchObject({ result: 'answer', spendCommittedMicroUsd: 8_000 });
  });

  it('does not let a worker publish over a cancellation', async () => {
    const executor: Executor = async () => {
      await store.jobs.cancel(OWNER, jobId, clock);
      return { kind: 'succeeded', result: 'late', spendMicroUsd: 0 };
    };
    expect(await runJob(deps(executor), message())).toBe('stale');
    expect(await job()).toMatchObject({ status: 'cancelled', result: null });
  });

  it('parks a long wait without holding the worker, and continues after it completes', async () => {
    const executor: Executor = async ({ job: current }) =>
      current.exec.checkpoints.ocr
        ? { kind: 'succeeded', result: 'text', spendMicroUsd: 0 }
        : { kind: 'waiting_external', ref: 'textract-1' };
    expect(await runJob(deps(executor), message())).toBe('waiting');
    expect(await job()).toMatchObject({ status: 'waiting_external' });
    expect(await runJob(deps(executor), message())).toBe('skipped');

    expect(await store.execution.resume(OWNER, jobId, 'textract-1', clock)).toBe(true);
    // The OCR step recorded its result before parking in a real executor; here we add it.
    const claim = await store.execution.claim(OWNER, jobId, clock, LEASE_MS);
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    await store.execution.checkpoint(claim.lease, 'ocr', { done: '1' }, clock);
    tick(LEASE_MS + 1);
    expect(await runJob(deps(executor), message())).toBe('succeeded');
  });

  it('clamps reported spend to the job’s cap', async () => {
    const executor: Executor = async () => ({
      kind: 'succeeded',
      result: 1,
      spendMicroUsd: 10_000_000,
    });
    await runJob(deps(executor), message());
    expect((await job())?.spendCommittedMicroUsd).toBe(50_000);
  });
});
