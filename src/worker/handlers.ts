import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';

import type { Logger } from '../lib/log';
import { dispatchEvent, parseWorkMessage, type WorkQueues } from '../lib/queue';
import type { Store } from '../lib/store';
import { jobError, runJob, type Executors } from './run';

/*
 * Lambda handlers for the three background roles. Each one is a plain function over injected
 * dependencies; the entry files at the repository's src root build them from configuration.
 */

type Clock = { now?: () => Date };

/**
 * SQS worker: one job per message (batch size 1 in the event source mapping), partial batch
 * failure reporting. A message that is not a work message is acknowledged: retrying it cannot help.
 * An infrastructure error (store unavailable) fails the message so SQS redelivers it.
 */
export function createWorkerHandler(
  deps: { store: Store; executors: Executors; logger: Logger } & Clock,
) {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      const message = parseWorkMessage(record.body);
      if (!message) {
        deps.logger.log('warn', { event: 'work_message_invalid' });
        continue;
      }
      try {
        await runJob(deps, message);
      } catch (error) {
        deps.logger.log('error', {
          event: 'run_error',
          jobId: message.jobId,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

const DISPATCH_BATCH = 100;
const DISPATCH_PASSES = 10;

/** Scheduled: sends every due outbox event that the immediate dispatch missed. */
export function createDispatcher(
  deps: { store: Store; queues: WorkQueues; logger: Logger } & Clock,
) {
  return async (): Promise<{ dispatched: number; failed: number }> => {
    const now = deps.now ?? (() => new Date());
    let dispatched = 0;
    let failed = 0;
    for (let pass = 0; pass < DISPATCH_PASSES; pass += 1) {
      const events = await deps.store.outbox.pending(DISPATCH_BATCH, now());
      let progress = 0;
      for (const event of events) {
        try {
          await dispatchEvent(deps, event, now());
          progress += 1;
        } catch (error) {
          failed += 1;
          deps.logger.log('warn', {
            event: 'dispatch_failed',
            jobId: event.jobId,
            errorName: error instanceof Error ? error.name : 'unknown',
          });
        }
      }
      dispatched += progress;
      // A full page of failures would repeat forever: leave it for the next run.
      if (events.length < DISPATCH_BATCH || progress === 0) break;
    }
    deps.logger.log('info', { event: 'dispatch_run', count: dispatched, failed });
    return { dispatched, failed };
  };
}

const RECONCILE_BATCH = 100;

/**
 * Scheduled: looks at live jobs whose next check is due. A job past its deadline expires; any other
 * is republished, which repairs lost sends and dead workers (the claim skips a job still leased).
 */
export function createReconciler(deps: { store: Store; logger: Logger } & Clock) {
  return async (): Promise<Record<string, number>> => {
    const now = deps.now ?? (() => new Date());
    const counts: Record<string, number> = { expired: 0, requeued: 0, settled: 0, missing: 0 };
    const due = await deps.store.execution.due(now(), RECONCILE_BATCH);
    for (const { ownerId, jobId } of due) {
      const result = await deps.store.execution.reconcile(ownerId, jobId, now());
      counts[result] = (counts[result] ?? 0) + 1;
    }
    deps.logger.log('info', {
      event: 'reconcile_run',
      count: due.length,
      outcome: JSON.stringify(counts),
    });
    return counts;
  };
}

/**
 * Dead letters: a message SQS gave up on. The job is ended visibly with a retryable error, so the
 * owner can retry it (POST /jobs/{id}/retry, which re-checks ownership, deadline and quota) instead
 * of the job idling until its deadline. Replay never bypasses those checks.
 */
export function createDeadLetterHandler(deps: { store: Store; logger: Logger } & Clock) {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const now = deps.now ?? (() => new Date());
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      const message = parseWorkMessage(record.body);
      if (!message) {
        deps.logger.log('warn', { event: 'work_message_invalid' });
        continue;
      }
      try {
        const result = await deps.store.execution.abandon(
          message.ownerId,
          message.jobId,
          jobError('internal_error', message.jobId),
          now(),
        );
        deps.logger.log('warn', {
          event: 'dead_letter',
          jobId: message.jobId,
          outcome: result,
        });
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}
