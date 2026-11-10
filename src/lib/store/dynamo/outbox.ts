import { createHash } from 'crypto';

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import type { OutboxEvent, OutboxStore } from '../types';
import { userKey, type Db } from './db';

/** Pending events are spread over this many index partitions so one hot key cannot throttle dispatch. */
export const OUTBOX_SHARDS = 8;

const shardOf = (jobId: string) =>
  (createHash('sha256').update(jobId).digest()[0] ?? 0) % OUTBOX_SHARDS;

type EventItem = {
  pk: string;
  sk: string;
  eventId: string;
  type: OutboxEvent['type'];
  ownerId: string;
  jobId: string;
  operation: OutboxEvent['operation'];
  createdAt: string;
};

const eventSort = (event: Pick<OutboxEvent, 'createdAt' | 'eventId'>) =>
  `${event.createdAt.toISOString()}#${event.eventId}`;

/** The outbox item for an event. Content-free: ids, an operation name and a time. */
export function eventItem(event: OutboxEvent, expiresAt: number) {
  return {
    pk: userKey(event.ownerId),
    sk: `EVT#${eventSort(event)}`,
    gsi1pk: `PENDING#${shardOf(event.jobId)}`,
    gsi1sk: eventSort(event),
    eventId: event.eventId,
    type: event.type,
    ownerId: event.ownerId,
    jobId: event.jobId,
    operation: event.operation,
    createdAt: event.createdAt.toISOString(),
    expiresAt,
  };
}

/**
 * The dispatcher reads undelivered events from the sparse GSI1 (an event leaves the index when it
 * is marked dispatched). It is a system reader across users; nothing user-facing calls it.
 */
export function createDynamoOutboxStore(db: Db): OutboxStore {
  return {
    async pending(limit) {
      const pages = await Promise.all(
        Array.from({ length: OUTBOX_SHARDS }, (_, shard) =>
          db.client.send(
            new QueryCommand({
              TableName: db.tables.outbox,
              IndexName: 'GSI1',
              KeyConditionExpression: 'gsi1pk = :shard',
              ExpressionAttributeValues: { ':shard': `PENDING#${shard}` },
              Limit: limit,
            }),
          ),
        ),
      );
      return pages
        .flatMap((page) => (page.Items ?? []) as (EventItem & { gsi1sk: string })[])
        .sort((left, right) => left.gsi1sk.localeCompare(right.gsi1sk))
        .slice(0, limit)
        .map((item) => ({
          eventId: item.eventId,
          type: item.type,
          ownerId: item.ownerId,
          jobId: item.jobId,
          operation: item.operation,
          createdAt: new Date(item.createdAt),
        }));
    },
    async markDispatched(event, now) {
      try {
        await db.client.send(
          new UpdateCommand({
            TableName: db.tables.outbox,
            Key: { pk: userKey(event.ownerId), sk: `EVT#${eventSort(event)}` },
            UpdateExpression: 'SET dispatchedAt = :now REMOVE gsi1pk, gsi1sk',
            // An event that already aged out must not be recreated by the update.
            ConditionExpression: 'attribute_exists(pk)',
            ExpressionAttributeValues: { ':now': now.toISOString() },
          }),
        );
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) {
          throw error;
        }
      }
    },
  };
}
