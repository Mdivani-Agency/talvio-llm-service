import type { JobError } from '@talvio/llm-contracts';
import { TERMINAL_JOB_STATUSES } from '@talvio/llm-contracts';

import type { Plan } from '../../plans';
import type { JobRecord, JobStage } from '../types';
import { userKey } from './db';

export const jobKey = (ownerId: string, jobId: string) => ({
  pk: userKey(ownerId),
  sk: `JOB#${jobId}`,
});
export const idemKey = (ownerId: string, key: string) => ({
  pk: userKey(ownerId),
  sk: `IDEM#${key}`,
});
export const resultKey = (ownerId: string, jobId: string) => ({
  pk: userKey(ownerId),
  sk: `RESULT#${jobId}`,
});
/** The admitted request: content, so it ages out with results (7 days). */
export const inputKey = (ownerId: string, jobId: string) => ({
  pk: userKey(ownerId),
  sk: `INPUT#${jobId}`,
});

export type JobItem = {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  jobId: string;
  ownerId: string;
  operation: JobRecord['operation'];
  status: JobRecord['status'];
  stage: JobStage;
  sessionId: string | null;
  contextRevisionId: string | null;
  parentJobId: string | null;
  idempotencyKey: string;
  requestHash: string;
  plan: Plan;
  limitsVersion: string;
  budgetCapMicroUsd: number;
  spendReservedMicroUsd: number;
  spendCommittedMicroUsd: number;
  pricingVersion: string;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  error: JobError | null;
  exec: ExecItem;
  expiresAt: number;
};

/** The executor's bookkeeping as stored: times are ISO strings so the item stays readable. */
export type ExecItem = {
  pipelineReleaseId: string;
  fence: number;
  leaseExpiresAt: string | null;
  availableAt: string | null;
  stepAttempts: Record<string, number>;
  checkpoints: Record<string, Record<string, string>>;
  externalRef: string | null;
};

export type IdemItem = { jobId: string; requestHash: string; expiresAt: number };
export type ResultItem = { result: unknown; expiresAt: number };

/**
 * A succeeded job whose result has aged out (7 days) while its metadata remains (30 days) is shown
 * as expired, so the record still satisfies the contract's "result exactly when succeeded".
 */
export const RESULT_GONE = (jobId: string): JobError => ({
  code: 'deadline_exceeded',
  message: 'The result of this job is no longer available.',
  retryable: false,
  correlationId: jobId,
});

export const toRecord = (item: JobItem, result: unknown | null): JobRecord => {
  if (item.status === 'succeeded' && result === null) {
    return toRecordAs(
      { ...item, status: 'expired', stage: 'done', error: RESULT_GONE(item.jobId) },
      null,
    );
  }
  return toRecordAs(item, result);
};

const toRecordAs = (item: JobItem, result: unknown | null): JobRecord => ({
  jobId: item.jobId,
  ownerId: item.ownerId,
  operation: item.operation,
  status: item.status,
  stage: item.stage,
  sessionId: item.sessionId,
  contextRevisionId: item.contextRevisionId,
  parentJobId: item.parentJobId,
  idempotencyKey: item.idempotencyKey,
  requestHash: item.requestHash,
  plan: item.plan,
  budgetCapMicroUsd: item.budgetCapMicroUsd,
  spendReservedMicroUsd: item.spendReservedMicroUsd,
  spendCommittedMicroUsd: item.spendCommittedMicroUsd,
  pricingVersion: item.pricingVersion,
  createdAt: new Date(item.createdAt),
  updatedAt: new Date(item.updatedAt),
  deadlineAt: new Date(item.deadlineAt),
  result,
  error: item.error,
  exec: {
    pipelineReleaseId: item.exec.pipelineReleaseId,
    fence: item.exec.fence,
    leaseExpiresAt: item.exec.leaseExpiresAt ? new Date(item.exec.leaseExpiresAt) : null,
    availableAt: item.exec.availableAt ? new Date(item.exec.availableAt) : null,
    stepAttempts: item.exec.stepAttempts,
    checkpoints: item.exec.checkpoints,
    externalRef: item.exec.externalRef,
  },
});

export const held = (job: Pick<JobRecord, 'status'>) => !TERMINAL_JOB_STATUSES.includes(job.status);
