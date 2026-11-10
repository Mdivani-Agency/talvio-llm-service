import { MAX_STEP_ATTEMPTS, LEASE_MS, retryDelayMs } from '../lib/execution';
import type { Logger } from '../lib/log';
import type { WorkMessage } from '../lib/queue';
import type { JobRecord, JobStage, Lease, Store } from '../lib/store';
import type { JobError, Operation } from '@talvio/llm-contracts';

/*
 * Runs one job for one delivered message. The message only names the job; everything else comes
 * from the store, so a duplicate, a late or a replayed message can do no more than a first one:
 * it either claims the job (nobody holds it and it is due) or is acknowledged and dropped.
 *
 * No store transaction is open while an executor works, and a long wait (OCR, a user) is parked as
 * waiting_external, so no Lambda stays open for it. An ambiguous failure may repeat a model call;
 * what stays exactly-once is publication and quota, because both are guarded by the lease's fence.
 */

export type StepContext = {
  job: JobRecord;
  lease: Lease;
  now: () => Date;
  /** Remembers provider ids for a step. False means the lease was lost: stop and return. */
  checkpoint(step: JobStage, refs: Record<string, string>): Promise<boolean>;
  /** Renews the lease during a long step. False means the lease was lost. */
  extendLease(): Promise<boolean>;
};

export type StepOutcome =
  | {
      kind: 'succeeded';
      result: unknown;
      /** The job's total spend so far in micro-USD, kept when the rest of its reservation is released. */
      spendMicroUsd: number;
    }
  | { kind: 'failed'; code: JobError['code']; spendMicroUsd?: number }
  /** A transient failure at `step`; retried with backoff while attempts and the deadline allow. */
  | { kind: 'retry'; step: JobStage; code?: 'dependency_unavailable' | 'internal_error' }
  | { kind: 'waiting_external'; ref: string };

export type Executor = (context: StepContext) => Promise<StepOutcome>;
export type Executors = Partial<Record<Operation, Executor>>;

/** Thrown by an executor for a failure worth retrying. Anything else thrown is treated the same way. */
export class TransientError extends Error {
  constructor(
    readonly step: JobStage,
    readonly code: 'dependency_unavailable' | 'internal_error' = 'dependency_unavailable',
  ) {
    super('Transient failure');
    this.name = 'TransientError';
  }
}

const MESSAGES: Record<JobError['code'], string> = {
  budget_exceeded: 'This job reached its spending limit.',
  input_policy_blocked: 'This input cannot be processed.',
  unsupported_language: 'This language is not supported.',
  unusable_document: 'This document could not be used.',
  ocr_page_limit: 'This document needs more text recognition than allowed.',
  validation_failed: 'The result could not be validated.',
  model_refusal: 'The request was declined.',
  output_truncated: 'The result was too long.',
  dependency_unavailable: 'A required service was unavailable. Try again.',
  deadline_exceeded: 'The job did not finish before its deadline.',
  cancelled: 'The job was cancelled.',
  revoked: 'Access to this job was revoked.',
  internal_error: 'Something went wrong. Try again.',
};

/** A stored job error carries a fixed message by code: nothing from the failure itself. */
export const jobError = (code: JobError['code'], jobId: string): JobError => ({
  code,
  message: MESSAGES[code],
  retryable: code === 'dependency_unavailable' || code === 'internal_error',
  correlationId: jobId,
});

export type RunDeps = {
  store: Store;
  executors: Executors;
  logger: Logger;
  now?: () => Date;
  leaseMs?: number;
  random?: () => number;
};

export type RunResult = 'skipped' | 'succeeded' | 'failed' | 'retrying' | 'waiting' | 'stale';

export async function runJob(deps: RunDeps, message: WorkMessage): Promise<RunResult> {
  const { store, executors, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const { ownerId, jobId } = message;

  const claim = await store.execution.claim(ownerId, jobId, now(), leaseMs);
  if (claim.kind === 'skipped') {
    logger.log('info', { event: 'run_skipped', jobId, reason: claim.reason });
    return 'skipped';
  }
  const { job } = claim;
  let lease = claim.lease;

  const finish = (outcome: RunResult, step?: string): RunResult => {
    logger.log(outcome === 'stale' ? 'warn' : 'info', {
      event: 'run_finished',
      jobId,
      operation: job.operation,
      outcome,
      step,
    });
    return outcome;
  };

  const executor = executors[job.operation];
  if (!executor) {
    // No executable for this operation in this release: say so now instead of idling to the deadline.
    const written = await store.execution.fail(
      lease,
      jobError('dependency_unavailable', jobId),
      { spendCommittedMicroUsd: job.spendCommittedMicroUsd },
      now(),
    );
    return finish(written === 'applied' ? 'failed' : 'stale');
  }

  const context: StepContext = {
    job,
    get lease() {
      return lease;
    },
    now,
    async checkpoint(step, refs) {
      return (await store.execution.checkpoint(lease, step, refs, now())) === 'applied';
    },
    async extendLease() {
      const next = await store.execution.extend(lease, now(), leaseMs);
      if (next) lease = next;
      return next !== null;
    },
  };

  let outcome: StepOutcome;
  try {
    outcome = await executor(context);
  } catch (error) {
    // Only the error's class is looked at: its message may quote input.
    outcome =
      error instanceof TransientError
        ? { kind: 'retry', step: error.step, code: error.code }
        : { kind: 'retry', step: job.stage, code: 'internal_error' };
    logger.log('warn', {
      event: 'step_error',
      jobId,
      step: outcome.kind === 'retry' ? outcome.step : undefined,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
  }

  const cap = job.budgetCapMicroUsd;
  const spend = (value: number | undefined) =>
    Math.max(0, Math.min(Math.floor(value ?? job.spendCommittedMicroUsd), cap));

  switch (outcome.kind) {
    case 'succeeded': {
      const written = await store.execution.succeed(
        lease,
        outcome.result,
        { spendCommittedMicroUsd: spend(outcome.spendMicroUsd) },
        now(),
      );
      return finish(written === 'applied' ? 'succeeded' : 'stale');
    }
    case 'failed': {
      const written = await store.execution.fail(
        lease,
        jobError(outcome.code, jobId),
        { spendCommittedMicroUsd: spend(outcome.spendMicroUsd) },
        now(),
      );
      return finish(written === 'applied' ? 'failed' : 'stale');
    }
    case 'waiting_external': {
      const written = await store.execution.waitExternal(lease, outcome.ref, now());
      return finish(written === 'applied' ? 'waiting' : 'stale');
    }
    case 'retry': {
      const code = outcome.code ?? 'dependency_unavailable';
      const attempt = (job.exec.stepAttempts[outcome.step] ?? 0) + 1;
      if (attempt >= MAX_STEP_ATTEMPTS) {
        // Bounded: after the last attempt a transient failure becomes a visible one.
        const written = await store.execution.fail(
          lease,
          jobError(code, jobId),
          { spendCommittedMicroUsd: spend(undefined) },
          now(),
        );
        return finish(written === 'applied' ? 'failed' : 'stale', outcome.step);
      }
      const at = new Date(now().getTime() + retryDelayMs(attempt, deps.random));
      // Never wait past the deadline: the claim at the deadline expires the job.
      const availableAt = at < job.deadlineAt ? at : job.deadlineAt;
      const written = await store.execution.retryLater(lease, outcome.step, availableAt, now());
      return finish(written === 'applied' ? 'retrying' : 'stale', outcome.step);
    }
  }
}
