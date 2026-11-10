import { randomUUID } from 'crypto';

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { RETENTION_MS } from '../../limits';
import type { DocumentRecord, DocumentStore } from '../types';
import { epochSeconds, fromEpochSeconds, isExpired, userKey, type Db } from './db';

const docKey = (ownerId: string, documentId: string) => ({
  pk: userKey(ownerId),
  sk: `DOC#${documentId}`,
});

type DocItem = Omit<DocumentRecord, 'createdAt' | 'expiresAt'> & {
  createdAt: string;
  expiresAt: number;
};

const toRecord = (item: DocItem): DocumentRecord => ({
  documentId: item.documentId,
  ownerId: item.ownerId,
  status: item.status,
  contentType: item.contentType,
  sizeBytes: item.sizeBytes,
  sha256: item.sha256,
  pageCount: item.pageCount,
  ocrPages: item.ocrPages,
  createdAt: new Date(item.createdAt),
  expiresAt: fromEpochSeconds(item.expiresAt),
});

/**
 * Document records (S3 keys and versions arrive with MDI-216). An upload that is never completed
 * expires after 24 hours; completing it moves the record to the 7-day content schedule.
 */
export function createDynamoDocumentStore(db: Db): DocumentStore {
  const { client, tables } = db;

  async function get(ownerId: string, documentId: string) {
    const { Item } = await client.send(
      new GetCommand({
        TableName: tables.sessions,
        Key: docKey(ownerId, documentId),
        ConsistentRead: true,
      }),
    );
    return Item && !isExpired(Item, new Date()) ? toRecord(Item as DocItem) : null;
  }

  return {
    async create(ownerId, request, now) {
      const documentId = randomUUID();
      const item: DocItem = {
        documentId,
        ownerId,
        status: 'awaiting_upload',
        contentType: request.contentType,
        sizeBytes: request.sizeBytes,
        sha256: request.sha256,
        pageCount: null,
        ocrPages: [],
        createdAt: now.toISOString(),
        expiresAt: epochSeconds(now) + RETENTION_MS.incompleteUpload / 1000,
      };
      await client.send(
        new PutCommand({
          TableName: tables.sessions,
          Item: { ...docKey(ownerId, documentId), ...item },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return toRecord(item);
    },
    get,
    async complete(ownerId, documentId, now) {
      try {
        const { Attributes } = await client.send(
          new UpdateCommand({
            TableName: tables.sessions,
            Key: docKey(ownerId, documentId),
            UpdateExpression: 'SET #status = :validating, expiresAt = :expires',
            ConditionExpression: '#status = :awaiting AND expiresAt > :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':validating': 'validating',
              ':awaiting': 'awaiting_upload',
              ':now': epochSeconds(now),
              ':expires': epochSeconds(now) + RETENTION_MS.content / 1000,
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return Attributes ? toRecord(Attributes as DocItem) : null;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          return get(ownerId, documentId);
        }
        throw error;
      }
    },
    async delete(ownerId, documentId) {
      const { Attributes } = await client.send(
        new DeleteCommand({
          TableName: tables.sessions,
          Key: docKey(ownerId, documentId),
          ReturnValues: 'ALL_OLD',
        }),
      );
      return Attributes !== undefined;
    },
  };
}
