import { randomUUID } from 'crypto';

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { RETENTION_MS } from '../../limits';
import type { DocumentRecord, DocumentStore, OutboxEvent } from '../types';
import { epochSeconds, fromEpochSeconds, isExpired, transact, userKey, type Db } from './db';
import { eventItem } from './outbox';
import { failedAt } from './quota';

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
  objectKey: item.objectKey,
  objectVersionId: item.objectVersionId,
  pageCount: item.pageCount,
  ocrPages: item.ocrPages,
  rejectionCode: item.rejectionCode,
  warnings: item.warnings,
  artifact: item.artifact,
  ocr: item.ocr ?? null,
  createdAt: new Date(item.createdAt),
  expiresAt: fromEpochSeconds(item.expiresAt),
});

/**
 * Document records. An upload that is never completed expires after 24 hours; completing it pins
 * the object version, moves the record to the 7-day content schedule and writes the
 * `document.validate` event in the same transaction.
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

  /** A conditional update of a validating document's own fields; false when the condition fails. */
  async function conditional(
    ownerId: string,
    documentId: string,
    update: string,
    condition: string,
    values: Record<string, unknown>,
    names: Record<string, string> = {},
  ): Promise<boolean> {
    try {
      await client.send(
        new UpdateCommand({
          TableName: tables.sessions,
          Key: docKey(ownerId, documentId),
          UpdateExpression: update,
          ConditionExpression: `#docstatus = :validating AND (${condition})`,
          ExpressionAttributeNames: { '#docstatus': 'status', ...names },
          ExpressionAttributeValues: { ':validating': 'validating', ...values },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  return {
    async create(ownerId, request, objectKey, now) {
      const documentId = randomUUID();
      const item: DocItem = {
        documentId,
        ownerId,
        status: 'awaiting_upload',
        contentType: request.contentType,
        sizeBytes: request.sizeBytes,
        sha256: request.sha256,
        objectKey,
        objectVersionId: null,
        pageCount: null,
        ocrPages: [],
        rejectionCode: null,
        warnings: [],
        artifact: null,
        ocr: null,
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
    async complete(ownerId, documentId, pin, now) {
      const event: OutboxEvent = {
        eventId: randomUUID(),
        type: 'document.validate',
        ownerId,
        jobId: documentId,
        operation: null,
        pipelineReleaseId: 'current',
        createdAt: now,
        availableAt: now,
      };
      try {
        await transact(db, [
          {
            Update: {
              TableName: tables.sessions,
              Key: docKey(ownerId, documentId),
              UpdateExpression:
                'SET #status = :validating, expiresAt = :expires, objectVersionId = :version',
              ConditionExpression: '#status = :awaiting AND expiresAt > :now',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':validating': 'validating',
                ':awaiting': 'awaiting_upload',
                ':now': epochSeconds(now),
                ':expires': epochSeconds(now) + RETENTION_MS.content / 1000,
                ':version': pin.versionId,
              },
            },
          },
          {
            Put: {
              TableName: tables.outbox,
              Item: eventItem(event, epochSeconds(now) + RETENTION_MS.metadata / 1000),
            },
          },
        ]);
      } catch (error) {
        if (failedAt(error, 0)) {
          const document = await get(ownerId, documentId);
          return document ? { document, event: null } : null;
        }
        throw error;
      }
      const document = await get(ownerId, documentId);
      return document ? { document, event } : null;
    },
    async beginOcr(ownerId, documentId, ocr) {
      return conditional(
        ownerId,
        documentId,
        'SET ocr = :ocr',
        'attribute_not_exists(ocr) OR ocr = :null',
        {
          ':ocr': {
            state: 'starting',
            clientToken: ocr.clientToken,
            textractJobId: null,
            pages: ocr.pages,
          },
          ':null': null,
        },
      );
    },
    async recordOcrJob(ownerId, documentId, clientToken, textractJobId) {
      return conditional(
        ownerId,
        documentId,
        'SET ocr.#state = :started, ocr.textractJobId = :job',
        'ocr.#state = :starting AND ocr.clientToken = :token',
        {
          ':started': 'started',
          ':starting': 'starting',
          ':token': clientToken,
          ':job': textractJobId,
        },
        { '#state': 'state' },
      );
    },
    async finish(ownerId, documentId, outcome) {
      const ready = outcome.kind === 'ready';
      try {
        const { Attributes } = await client.send(
          new UpdateCommand({
            TableName: tables.sessions,
            Key: docKey(ownerId, documentId),
            UpdateExpression: ready
              ? 'SET #status = :next, warnings = :warnings, pageCount = :pages, ocrPages = :ocr, artifact = :artifact'
              : 'SET #status = :next, warnings = :warnings, rejectionCode = :code',
            ConditionExpression: '#status = :validating',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':validating': 'validating',
              ':next': ready ? 'ready' : 'rejected',
              ':warnings': outcome.warnings,
              ...(outcome.kind === 'ready'
                ? {
                    ':pages': outcome.pageCount,
                    ':ocr': outcome.ocrPages,
                    ':artifact': outcome.artifact,
                  }
                : { ':code': outcome.code }),
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return Attributes ? toRecord(Attributes as DocItem) : null;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return null;
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
      return Attributes ? toRecord(Attributes as DocItem) : null;
    },
  };
}
