import {
  LIMITS_VERSION,
  PLAN_LIMITS,
  PLANNING_BUDGET_MICRO_USD,
  limitOverrideSchema,
  resolveLimits,
  type UserLimits,
} from './limits';
import type { Plan } from './plans';

describe('resolveLimits', () => {
  it('gives the free plan the documented defaults', () => {
    expect(resolveLimits('free')).toEqual({
      jobsPerDay: 20,
      activeJobs: 2,
      dailySpendMicroUsd: 1_000_000,
      jobCapMicroUsd: 50_000,
      jobBudgetMicroUsd: 50_000,
      version: LIMITS_VERSION,
    });
  });

  it('keeps the per-job cap under the planning budget and the day within the spend limit', () => {
    const free = PLAN_LIMITS.free;
    expect(free.jobCapMicroUsd).toBeLessThanOrEqual(PLANNING_BUDGET_MICRO_USD);
    // 20 jobs at the cap fit the day exactly, so the two limits agree.
    expect(free.jobsPerDay * free.jobCapMicroUsd).toBeLessThanOrEqual(free.dailySpendMicroUsd);
  });

  it('resolves a higher-tier plan from the table', () => {
    const plus: UserLimits = {
      jobsPerDay: 200,
      activeJobs: 5,
      dailySpendMicroUsd: 10_000_000,
      jobCapMicroUsd: 200_000,
    };
    const resolved = resolveLimits('plus' as Plan, null, { ...PLAN_LIMITS, plus });
    expect(resolved).toMatchObject({ ...plus, jobBudgetMicroUsd: PLANNING_BUDGET_MICRO_USD });
  });

  it('applies a per-user override over the plan, up or down', () => {
    expect(resolveLimits('free', { activeJobs: 4, jobsPerDay: 5 })).toMatchObject({
      activeJobs: 4,
      jobsPerDay: 5,
      dailySpendMicroUsd: 1_000_000,
    });
    expect(resolveLimits('free', { jobCapMicroUsd: 20_000 }).jobBudgetMicroUsd).toBe(20_000);
  });

  it('falls back to the lowest plan for a plan the table lacks', () => {
    expect(resolveLimits('mystery' as Plan)).toMatchObject(PLAN_LIMITS.free);
  });
});

describe('limitOverrideSchema', () => {
  it('accepts any subset of whole non-negative amounts', () => {
    expect(limitOverrideSchema.parse({})).toEqual({});
    expect(limitOverrideSchema.parse({ activeJobs: 0, dailySpendMicroUsd: 2_000_000 })).toEqual({
      activeJobs: 0,
      dailySpendMicroUsd: 2_000_000,
    });
  });

  it.each([{ activeJobs: -1 }, { jobsPerDay: 1.5 }, { surprise: 1 }, { activeJobs: '3' }])(
    'rejects %j',
    (value) => {
      expect(limitOverrideSchema.safeParse(value).success).toBe(false);
    },
  );
});
