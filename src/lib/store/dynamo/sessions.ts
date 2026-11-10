import { randomUUID } from 'crypto';

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Answer, ContextRevision } from '@talvio/llm-contracts';

import { RETENTION_MS } from '../../limits';
import { answeredContext, firstContext } from '../context';
import {
  IdempotencyConflictError,
  type QuestionSetRecord,
  type SessionRecord,
  type SessionStore,
} from '../types';
import { epochSeconds, fromEpochSeconds, isExpired, transact, userKey, type Db } from './db';
import { failedAt } from './quota';

const sessionKey = (ownerId: string, sessionId: string) => ({
  pk: userKey(ownerId),
  sk: `SESS#${sessionId}`,
});
const idemKey = (ownerId: string, clientRequestId: string) => ({
  pk: userKey(ownerId),
  sk: `SIDEM#${clientRequestId}`,
});
const questionSetKey = (ownerId: string, sessionId: string, questionSetId: string) => ({
  pk: userKey(ownerId),
  sk: `SESS#${sessionId}#QSET#${questionSetId}`,
});

type SessionItem = Omit<SessionRecord, 'createdAt' | 'expiresAt'> & {
  createdAt: string;
  expiresAt: number;
};

const toRecord = (item: SessionItem): SessionRecord => ({
  sessionId: item.sessionId,
  ownerId: item.ownerId,
  purpose: item.purpose,
  status: item.status,
  clientRequestId: item.clientRequestId,
  requestHash: item.requestHash,
  latestContext: item.latestContext,
  questionRoundsUsed: item.questionRoundsUsed,
  questionsIssued: item.questionsIssued,
  createdAt: new Date(item.createdAt),
  expiresAt: fromEpochSeconds(item.expiresAt),
});

const contentExpiry = (now: Date) => epochSeconds(now) + RETENTION_MS.content / 1000;

export function createDynamoSessionStore(db: Db): SessionStore {
  const { client, tables } = db;

  async function get(ownerId: string, sessionId: string) {
    const { Item } = await client.send(
      new GetCommand({
        TableName: tables.sessions,
        Key: sessionKey(ownerId, sessionId),
        ConsistentRead: true,
      }),
    );
    return Item && !isExpired(Item, new Date()) ? toRecord(Item as SessionItem) : null;
  }

  async function existing(ownerId: string, clientRequestId: string, requestHash: string) {
    const { Item } = await client.send(
      new GetCommand({
        TableName: tables.sessions,
        Key: idemKey(ownerId, clientRequestId),
        ConsistentRead: true,
      }),
    );
    if (!Item || isExpired(Item, new Date())) {
      return null;
    }
    if (Item.requestHash !== requestHash) {
      throw new IdempotencyConflictError();
    }
    const session = await get(ownerId, Item.sessionId as string);
    return session ? { session, replayed: true } : null;
  }

  /** Makes the context change conditional on the revision the caller saw being the latest. */
  const staleOrMissing = async (ownerId: string, sessionId: string) =>
    (await get(ownerId, sessionId)) ? ('stale' as const) : null;

  async function listChildren(ownerId: string, sessionId: string) {
    const keys: { pk: string; sk: string }[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await client.send(
        new QueryCommand({
          TableName: tables.sessions,
          KeyConditionExpression: 'pk = :owner AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: {
            ':owner': userKey(ownerId),
            ':prefix': `SESS#${sessionId}#`,
          },
          ProjectionExpression: 'pk, sk',
          ExclusiveStartKey: start,
        }),
      );
      keys.push(...((page.Items ?? []) as { pk: string; sk: string }[]));
      start = page.LastEvaluatedKey;
    } while (start);
    return keys;
  }

  return {
    async create({ ownerId, clientRequestId, requestHash, purpose, context, now }) {
      const replay = await existing(ownerId, clientRequestId, requestHash);
      if (replay) {
        return replay;
      }
      const sessionId = randomUUID();
      const expiresAt = contentExpiry(now);
      const item: SessionItem = {
        sessionId,
        ownerId,
        purpose,
        status: 'open',
        clientRequestId,
        requestHash,
        latestContext: firstContext(sessionId, context, now),
        questionRoundsUsed: 0,
        questionsIssued: 0,
        createdAt: now.toISOString(),
        expiresAt,
      };
      try {
        await transact(db, [
          {
            Put: {
              TableName: tables.sessions,
              Item: { ...sessionKey(ownerId, sessionId), ...item },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Put: {
              TableName: tables.sessions,
              Item: { ...idemKey(ownerId, clientRequestId), sessionId, requestHash, expiresAt },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ]);
      } catch (error) {
        if (failedAt(error, 1)) {
          const winner = await existing(ownerId, clientRequestId, requestHash);
          if (winner) {
            return winner;
          }
        }
        throw error;
      }
      return { session: toRecord(item), replayed: false };
    },

    get,

    async addContext({ ownerId, sessionId, baseContextRevisionId, context, now }) {
      const next = firstContext(sessionId, context, now);
      try {
        await transact(db, [
          {
            Update: {
              TableName: tables.sessions,
              Key: sessionKey(ownerId, sessionId),
              UpdateExpression: 'SET latestContext = :next',
              ConditionExpression:
                'attribute_exists(pk) AND latestContext.contextRevisionId = :base AND expiresAt > :now',
              ExpressionAttributeValues: {
                ':next': next,
                ':base': baseContextRevisionId,
                ':now': epochSeconds(now),
              },
            },
          },
        ]);
        return next;
      } catch (error) {
        if (failedAt(error, 0) || error instanceof ConditionalCheckFailedException) {
          return staleOrMissing(ownerId, sessionId);
        }
        throw error;
      }
    },

    async getQuestionSet(ownerId, sessionId, questionSetId) {
      const { Item } = await client.send(
        new GetCommand({
          TableName: tables.sessions,
          Key: questionSetKey(ownerId, sessionId, questionSetId),
          ConsistentRead: true,
        }),
      );
      if (!Item || isExpired(Item, new Date())) {
        return null;
      }
      return {
        questionSetId: Item.questionSetId,
        sessionId: Item.sessionId,
        round: Item.round,
        questions: Item.questions,
        sourceHash: Item.sourceHash,
        jobDescriptionHash: Item.jobDescriptionHash,
      } as QuestionSetRecord;
    },

    async saveQuestionSet(ownerId, set, now) {
      if (!(await get(ownerId, set.sessionId))) {
        return null;
      }
      await client.send(
        new PutCommand({
          TableName: tables.sessions,
          Item: {
            ...questionSetKey(ownerId, set.sessionId, set.questionSetId),
            ...set,
            expiresAt: contentExpiry(now),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return set;
    },

    async addAnswers({
      ownerId,
      sessionId,
      baseContextRevisionId,
      questionSetId,
      answers,
      answersHash,
      now,
    }) {
      const session = await get(ownerId, sessionId);
      if (!session) {
        return null;
      }
      if (session.latestContext.contextRevisionId !== baseContextRevisionId) {
        return 'stale';
      }
      const { context, answerRevisionId } = answeredContext(
        session.latestContext,
        answersHash,
        now,
      );
      try {
        await transact(db, [
          {
            Update: {
              TableName: tables.sessions,
              Key: sessionKey(ownerId, sessionId),
              UpdateExpression: 'SET latestContext = :next',
              ConditionExpression:
                'attribute_exists(pk) AND latestContext.contextRevisionId = :base AND expiresAt > :now',
              ExpressionAttributeValues: {
                ':next': context,
                ':base': baseContextRevisionId,
                ':now': epochSeconds(now),
              },
            },
          },
          {
            Put: {
              TableName: tables.sessions,
              Item: {
                pk: userKey(ownerId),
                sk: `SESS#${sessionId}#ANS#${answerRevisionId}`,
                answerRevisionId,
                sessionId,
                questionSetId,
                answersHash,
                answers: answers satisfies Answer[],
                contextRevisionId: context.contextRevisionId,
                expiresAt: contentExpiry(now),
              },
            },
          },
        ]);
        return context satisfies ContextRevision;
      } catch (error) {
        if (failedAt(error, 0)) {
          return staleOrMissing(ownerId, sessionId);
        }
        throw error;
      }
    },

    async delete(ownerId, sessionId) {
      const session = await get(ownerId, sessionId);
      if (!session) {
        return false;
      }
      // Children (question sets, answer revisions) go first so none outlives its session.
      const children = await listChildren(ownerId, sessionId);
      await Promise.all(
        [...children, idemKey(ownerId, session.clientRequestId)].map((Key) =>
          client.send(new DeleteCommand({ TableName: tables.sessions, Key })),
        ),
      );
      await client.send(
        new DeleteCommand({ TableName: tables.sessions, Key: sessionKey(ownerId, sessionId) }),
      );
      return true;
    },
  };
}
