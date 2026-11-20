import { z } from 'zod';

import { LIMITS, type Operation } from '@talvio/llm-contracts';

import { PLANS, type Plan } from './plans';

/*
 * Per-user limits (design §11, MDI-214). One versioned table of defaults per plan, optionally
 * adjusted per user by an override item in the quotas table, so a subscription tier (MDI-321)
 * or a support exception needs a data change, not a deploy. Money is integer micro-USD.
 */

/** Bump when a default below changes, so job records show which table admitted them. */
export const LIMITS_VERSION = '2026-11-20.1';

/** Price table jobs are admitted and settled under (src/lib/model/pricing.ts). */
export { PRICING_VERSION } from './model/pricing';

/** Budget the planner may spend on one job before the hard cap applies. */
export const PLANNING_BUDGET_MICRO_USD = 100_000;

export type UserLimits = {
  /** Jobs admitted per UTC day. */
  jobsPerDay: number;
  /** Jobs queued or running at once. */
  activeJobs: number;
  /** Reserved plus committed spend per UTC day. */
  dailySpendMicroUsd: number;
  /** Hard cap for one job; preflight uses the lower of this and the planning budget. */
  jobCapMicroUsd: number;
  /**
   * Operations a user may run once, ever (MDI-649). The first admitted job holds the operation
   * for good in the quotas table (no TTL); a replay or a retry of that job does not count again,
   * and only a job that failed without spending anything gives it back to a later admission.
   */
  oncePerUser?: readonly Operation[];
};

export const PLAN_LIMITS: Record<Plan, UserLimits> = {
  free: {
    jobsPerDay: LIMITS.jobsPerUserPerDay,
    activeJobs: LIMITS.activeJobsPerUser,
    dailySpendMicroUsd: 1_000_000,
    jobCapMicroUsd: 50_000,
    // The free profile improvement after onboarding (talvio-web-app MDI-643).
    oncePerUser: ['improve_profile'],
  },
};

/** Account-wide spend ceiling per UTC day, used when ACCOUNT_DAILY_CEILING_MICRO_USD is unset. */
export const DEFAULT_ACCOUNT_DAILY_CEILING_MICRO_USD = 5_000_000;

const amount = z.number().int().min(0).max(1_000_000_000);

/** The override item. Any subset of limits; unknown fields are rejected, not ignored. */
export const limitOverrideSchema = z
  .object({
    jobsPerDay: amount,
    activeJobs: amount,
    dailySpendMicroUsd: amount,
    jobCapMicroUsd: amount,
  })
  .partial()
  .strict();

export type LimitOverride = z.infer<typeof limitOverrideSchema>;

export type ResolvedLimits = UserLimits & {
  /** What admission reserves for a job: the lower of the job cap and the planning budget. */
  jobBudgetMicroUsd: number;
  version: string;
};

/** Plan defaults, then the user's override. An unknown plan resolves to the lowest-trust plan. */
export function resolveLimits(
  plan: Plan,
  override: LimitOverride | null = null,
  table: Record<string, UserLimits> = PLAN_LIMITS,
): ResolvedLimits {
  const base = table[plan] ?? PLAN_LIMITS[PLANS[0]];
  const merged: UserLimits = { ...base, ...(override ?? {}) };
  return {
    ...merged,
    jobBudgetMicroUsd: Math.min(merged.jobCapMicroUsd, PLANNING_BUDGET_MICRO_USD),
    version: LIMITS_VERSION,
  };
}

/** Which limit refused an admission. Safe to log and to show: it names no user data. */
export type QuotaKind = 'jobs_per_day' | 'active_jobs' | 'daily_spend' | 'account_ceiling';

export class QuotaExceededError extends Error {
  constructor(readonly kind: QuotaKind) {
    super(`Quota exceeded: ${kind}`);
    this.name = 'QuotaExceededError';
  }
}

/** The user already ran an operation their plan allows once (`oncePerUser`). Not retryable. */
export class OperationLimitError extends Error {
  constructor(readonly operation: Operation) {
    super(`Operation limit reached: ${operation}`);
    this.name = 'OperationLimitError';
  }
}

/** True when the limits allow `operation` once per user. */
export const isOncePerUser = (limits: Pick<UserLimits, 'oncePerUser'>, operation: Operation) =>
  limits.oncePerUser?.includes(operation) ?? false;

/** Retention schedule (design §13). TTL drives it; reads also refuse items past their time. */
export const RETENTION_MS = {
  /** Uploads that were never completed. */
  incompleteUpload: 24 * 60 * 60 * 1000,
  /** Result payloads, session content, documents and answers. */
  content: 7 * 24 * 60 * 60 * 1000,
  /** Content-free job metadata, idempotency records and outbox events. */
  metadata: 30 * 24 * 60 * 60 * 1000,
} as const;
