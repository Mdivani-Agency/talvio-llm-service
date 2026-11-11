import { randomUUID } from 'crypto';

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type {
  Answer,
  ContextRevision,
  JobDescription,
  SourceSnapshot,
} from '@talvio/llm-contracts';

import { RETENTION_MS } from '../../limits';
import { answeredContext, firstContext } from '../context';
import {
  IdempotencyConflictError,
  type AnswerSubmission,
  type ContextInput,
  type QuestionSetRecord,
  type SessionRecord,
  type SessionStore,
} from '../types';
import { epochSeconds, fromEpochSeconds, isExpired, transact, userKey, type Db } from './db';
import { jobKey } from './job-items';
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

const childKey = (ownerId: string, sessionId: string, kind: string, id: string) => ({
  pk: userKey(ownerId),
  sk: `SESS#${sessionId}#${kind}#${id}`,
});

/** Round holders are top-level attributes (`round1`, `round2`), so no map has to exist first. */
export const roundAttribute = (round: number) => `round${round}`;

type SessionItem = Omit<SessionRecord, 'createdAt' | 'expiresAt' | 'rounds'> & {
  createdAt: string;
  expiresAt: number;
  [round: `round${number}`]: { jobId: string; slots: number } | undefined;
};

const roundsOf = (item: SessionItem): SessionRecord['rounds'] => {
  const rounds: SessionRecord['rounds'] = {};
  for (const [key, value] of Object.entries(item)) {
    const match = /^round(\d+)$/.exec(key);
    if (match && value && typeof value === 'object') {
      rounds[Number(match[1])] = value as { jobId: string; slots: number };
    }
  }
  return rounds;
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
  rounds: roundsOf(item),
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

  /**
   * The content a revision refers to: the revision itself, and its source and job description
   * keyed by hash (unchanged content is written again, not duplicated). Expires with the session.
   */
  const contentPuts = (
    ownerId: string,
    sessionId: string,
    revision: ContextRevision,
    context: Pick<ContextInput, 'source' | 'jobDescription'> | null,
    expiresAt: number,
  ) => {
    const put = (key: { pk: string; sk: string }, fields: Record<string, unknown>) => ({
      Put: { TableName: tables.sessions, Item: { ...key, ...fields, expiresAt } },
    });
    return [
      put(childKey(ownerId, sessionId, 'CTX', revision.contextRevisionId), { revision }),
      ...(context
        ? [
            put(childKey(ownerId, sessionId, 'SRC', revision.sourceHash), {
              source: context.source,
            }),
            ...(context.jobDescription && revision.jobDescriptionHash
              ? [
                  put(childKey(ownerId, sessionId, 'JD', revision.jobDescriptionHash), {
                    jobDescription: context.jobDescription,
                  }),
                ]
              : []),
          ]
        : []),
    ];
  };

  async function child<T>(key: { pk: string; sk: string }): Promise<T | null> {
    const { Item } = await client.send(
      new GetCommand({ TableName: tables.sessions, Key: key, ConsistentRead: true }),
    );
    return Item && !isExpired(Item, new Date()) ? (Item as T) : null;
  }

  async function children(ownerId: string, sessionId: string, kind: string) {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await client.send(
        new QueryCommand({
          TableName: tables.sessions,
          KeyConditionExpression: 'pk = :owner AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: {
            ':owner': userKey(ownerId),
            ':prefix': `SESS#${sessionId}#${kind}#`,
          },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start);
    const now = new Date();
    return items.filter((item) => !isExpired(item, now));
  }

  const toQuestionSet = (item: Record<string, unknown>): QuestionSetRecord => ({
    questionSetId: item.questionSetId as string,
    sessionId: item.sessionId as string,
    round: item.round as number,
    questions: item.questions as QuestionSetRecord['questions'],
    sourceHash: item.sourceHash as string,
    jobDescriptionHash: (item.jobDescriptionHash as string | null) ?? null,
    jobId: (item.jobId as string | null) ?? null,
  });

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
              // A record past its TTL is logically gone even if the sweeper has not removed it.
              ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
              ExpressionAttributeValues: { ':now': epochSeconds(now) },
            },
          },
          ...contentPuts(ownerId, sessionId, item.latestContext, context, expiresAt),
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
      const session = await get(ownerId, sessionId);
      if (!session) return null;
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
          ...contentPuts(ownerId, sessionId, next, context, epochSeconds(session.expiresAt)),
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
      return toQuestionSet(Item);
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
                createdAt: now.toISOString(),
                expiresAt: contentExpiry(now),
              },
            },
          },
          ...contentPuts(ownerId, sessionId, context, null, epochSeconds(session.expiresAt)),
        ]);
        return context satisfies ContextRevision;
      } catch (error) {
        if (failedAt(error, 0)) {
          return staleOrMissing(ownerId, sessionId);
        }
        throw error;
      }
    },

    async context(ownerId, sessionId, contextRevisionId) {
      if (!(await get(ownerId, sessionId))) return null;
      const ctx = await child<{ revision: ContextRevision }>(
        childKey(ownerId, sessionId, 'CTX', contextRevisionId),
      );
      if (!ctx) return null;
      const { revision } = ctx;
      const [source, jd, sets, answers] = await Promise.all([
        child<{ source: SourceSnapshot }>(childKey(ownerId, sessionId, 'SRC', revision.sourceHash)),
        revision.jobDescriptionHash
          ? child<{ jobDescription: JobDescription }>(
              childKey(ownerId, sessionId, 'JD', revision.jobDescriptionHash),
            )
          : Promise.resolve(null),
        children(ownerId, sessionId, 'QSET'),
        children(ownerId, sessionId, 'ANS'),
      ]);
      if (!source || (revision.jobDescriptionHash && !jd)) return null;
      const upTo = new Date(revision.createdAt);
      return {
        revision,
        source: source.source,
        jobDescription: jd?.jobDescription ?? null,
        questionSets: sets.map(toQuestionSet).sort((a, b) => a.round - b.round),
        answers: answers
          .map(
            (item): AnswerSubmission => ({
              answerRevisionId: item.answerRevisionId as string,
              questionSetId: item.questionSetId as string,
              answers: item.answers as Answer[],
              createdAt: new Date((item.createdAt as string | undefined) ?? 0),
            }),
          )
          .filter((submission) => submission.createdAt <= upTo)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      };
    },

    async issueQuestionSet(lease, set, now) {
      const { ownerId, jobId } = lease;
      const session = await get(ownerId, set.sessionId);
      if (!session) return 'stale';
      const key = questionSetKey(ownerId, set.sessionId, set.questionSetId);
      try {
        await transact(db, [
          {
            Put: {
              TableName: tables.sessions,
              Item: { ...key, ...set, jobId, expiresAt: epochSeconds(session.expiresAt) },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: tables.sessions,
              Key: sessionKey(ownerId, set.sessionId),
              UpdateExpression: 'SET questionRoundsUsed = :round ADD questionsIssued :count',
              ConditionExpression:
                'attribute_exists(pk) AND #holder.jobId = :job AND questionRoundsUsed = :previous AND expiresAt > :now',
              ExpressionAttributeNames: { '#holder': roundAttribute(set.round) },
              ExpressionAttributeValues: {
                ':round': set.round,
                ':previous': set.round - 1,
                ':count': set.questions.length,
                ':job': jobId,
                ':now': epochSeconds(now),
              },
            },
          },
          {
            // Only the worker that still holds the job may issue: a cancelled, expired or
            // reclaimed job must not spend the round.
            ConditionCheck: {
              TableName: tables.jobs,
              Key: jobKey(ownerId, jobId),
              ConditionExpression:
                '#status = :running AND #exec.#fence = :fence AND deadlineAt > :deadline',
              ExpressionAttributeNames: { '#status': 'status', '#exec': 'exec', '#fence': 'fence' },
              ExpressionAttributeValues: {
                ':running': 'running',
                ':fence': lease.fence,
                ':deadline': now.toISOString(),
              },
            },
          },
        ]);
        return 'issued';
      } catch (error) {
        if ([0, 1, 2].some((index) => failedAt(error, index))) {
          // Already issued by this job (a repeat after a lost response) counts as issued.
          const issued = await child<Record<string, unknown>>(key);
          return issued?.jobId === jobId ? 'issued' : 'stale';
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
