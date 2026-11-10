import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { z } from 'zod';

import { ApiError } from './errors';
import type { OutboxEvent, OutboxEventType, Store } from './store';

/*
 * Work queues. One standard SQS queue per pipeline release; a message names a job and carries no
 * content, so the worker always reads the current state from the store. Duplicates and reordering
 * are expected: the store's lease makes them harmless.
 */

export const WORK_MESSAGE_VERSION = 1;

export const workMessageSchema = z.strictObject({
  v: z.literal(WORK_MESSAGE_VERSION),
  type: z.enum(['job.admitted', 'job.retried', 'job.requeue', 'job.retry', 'job.resume']),
  ownerId: z.uuid(),
  jobId: z.uuid(),
  eventId: z.uuid(),
});

export type WorkMessage = z.infer<typeof workMessageSchema>;

/** A body that is not a work message, or null. Such messages are acknowledged, never retried. */
export function parseWorkMessage(body: string): WorkMessage | null {
  try {
    const parsed = workMessageSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface WorkQueues {
  send(releaseId: string, message: WorkMessage): Promise<void>;
}

export function createSqsQueues(
  urls: Record<string, string>,
  client: Pick<SQSClient, 'send'> = new SQSClient({ maxAttempts: 3 }),
): WorkQueues {
  return {
    async send(releaseId, message) {
      const url = urls[releaseId];
      if (!url) {
        // A job pinned to a release this deployment has no queue for cannot be dispatched here.
        throw new Error('no work queue for release');
      }
      await client.send(
        new SendMessageCommand({ QueueUrl: url, MessageBody: JSON.stringify(message) }),
      );
    },
  };
}

/** Local runs without SQS: sends fail, which the callers treat as "the dispatcher will retry". */
export function createNoQueues(): WorkQueues {
  return {
    async send() {
      throw new ApiError('dependency_unavailable');
    },
  };
}

export type SentMessage = { releaseId: string; message: WorkMessage };

/** In-process queues for tests: records what was sent, can be made to fail. */
export function createMemoryQueues(): WorkQueues & { sent: SentMessage[]; failNext: number } {
  const queues = {
    sent: [] as SentMessage[],
    failNext: 0,
    async send(releaseId: string, message: WorkMessage) {
      if (queues.failNext > 0) {
        queues.failNext -= 1;
        throw new Error('queue unavailable');
      }
      queues.sent.push({ releaseId, message });
    },
  };
  return queues;
}

export const toWorkMessage = (event: OutboxEvent): WorkMessage => ({
  v: WORK_MESSAGE_VERSION,
  type: event.type satisfies OutboxEventType,
  ownerId: event.ownerId,
  jobId: event.jobId,
  eventId: event.eventId,
});

/** Sends one event and then marks it dispatched. A crash between the two sends it again, which is fine. */
export async function dispatchEvent(
  deps: { store: Pick<Store, 'outbox'>; queues: WorkQueues },
  event: OutboxEvent,
  now: Date,
): Promise<void> {
  await deps.queues.send(event.pipelineReleaseId, toWorkMessage(event));
  await deps.store.outbox.markDispatched(event, now);
}
