/*
 * The job's spend ledger lives in its checkpoints, written under the lease before and after each
 * paid call, so a crash or a duplicate delivery sees every call that may have been charged. An
 * entry is `<bound>` while the call's outcome is unknown and `<bound>:<actual>` once settled; an
 * unsettled entry counts at its bound. Only the lease holder writes it, and the lease's fence
 * guards every write, so two workers can never both spend against the same remaining budget.
 */

const PREFIX = 'spend.';

export type Ledger = Record<string, Record<string, string>>;

export function spentMicroUsd(checkpoints: Ledger): number {
  let total = 0;
  for (const refs of Object.values(checkpoints)) {
    for (const [key, value] of Object.entries(refs)) {
      if (!/^spend\.\d+$/.test(key)) continue;
      const [bound, actual] = value.split(':').map(Number);
      total += Number.isFinite(actual) ? actual! : (bound ?? 0);
    }
  }
  return total;
}

/** Next unused entry key in a step's refs. */
export function nextEntry(refs: Record<string, string>): string {
  let n = 1;
  while (`${PREFIX}${n}` in refs) n += 1;
  return `${PREFIX}${n}`;
}

export const reserved = (bound: number) => String(bound);
export const settled = (bound: number, actual: number) => `${bound}:${actual}`;

/**
 * What a job has spent over its whole life: the larger of what was last settled and what its
 * ledger records, never above its cap. Every terminal path (success, failure, retry exhaustion,
 * expiry, cancel, delete) settles quota with this, so a paid call is never released as unspent.
 */
export function committedSpend(job: {
  budgetCapMicroUsd: number;
  spendCommittedMicroUsd: number;
  exec: { checkpoints: Ledger };
}): number {
  return Math.min(
    Math.max(job.spendCommittedMicroUsd, spentMicroUsd(job.exec.checkpoints)),
    job.budgetCapMicroUsd,
  );
}
