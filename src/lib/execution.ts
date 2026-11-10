/*
 * Limits of the executor (design §8). Shared by the stores, the worker and the reconciler so the
 * numbers that bound a job cannot drift apart.
 */

/** At most three application attempts per step; a schema repair is a separate, single allowance. */
export const MAX_STEP_ATTEMPTS = 3;

/** First retry waits about this long, doubling with each attempt, capped below. */
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 60_000;

/**
 * A lease outlives the worker Lambda timeout (300 s, Terraform `worker_timeout_seconds`) by a
 * minute, so a worker that is still running is never reclaimed before it can be cut off.
 */
export const LEASE_MS = 360_000;

/**
 * Grace before the reconciler looks at a job whose work should already be moving: long enough for
 * the dispatcher (every minute) and a queue hop, short enough to repair a lost send quickly.
 */
export const DISPATCH_GRACE_MS = 2 * 60_000;

/** Backoff before attempt `attempt + 1`, with half the exponential ceiling fixed and the rest jittered. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/**
 * Whether a dead-lettered message may still end its job: only when nothing else is driving it.
 * A queued job, a retry that is due, or a running job whose lease lapsed has no live worker; a job
 * that is waiting on an external operation, or running under a live lease, has moved on.
 */
export function abandonable(
  job: { status: string; leaseExpiresAt: Date | null; availableAt: Date | null },
  now: Date,
): boolean {
  switch (job.status) {
    case 'queued':
      return true;
    case 'retry_wait':
      return job.availableAt === null || job.availableAt <= now;
    case 'running':
      return job.leaseExpiresAt === null || job.leaseExpiresAt <= now;
    default:
      return false;
  }
}
