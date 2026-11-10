import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';

/*
 * Table layout. Terraform creates the four tables (talvio-terraform-iac, modules/llm) with the
 * same generic shape: string keys `pk` and `sk`, GSI1 on `gsi1pk`/`gsi1sk`, and TTL on
 * `expiresAt` (epoch seconds). Every key starts with the owner, so no access pattern can read
 * across users and none uses a scan.
 *
 *   jobs      U#<owner> | JOB#<jobId>            job metadata, 30 days
 *             U#<owner> | IDEM#<key>             idempotency record, 30 days
 *             U#<owner> | RESULT#<jobId>         published result payload, 7 days
 *             GSI1 U#<owner>#JOBS | <iso>#<id>   newest-first listing
 *   sessions  U#<owner> | SESS#<sid>             session and latest context, 7 days
 *             U#<owner> | SIDEM#<clientRequestId>
 *             U#<owner> | SESS#<sid>#QSET#<id>   question sets
 *             U#<owner> | SESS#<sid>#ANS#<id>    answer revisions
 *             U#<owner> | DOC#<documentId>       documents, 24 hours until completed, then 7 days
 *   quotas    U#<owner> | DAY#<yyyy-mm-dd>       jobs, reserved and used micro-USD per UTC day
 *             U#<owner> | ACTIVE                 queued or running jobs
 *             U#<owner> | LIMITS                 optional per-user limit override
 *             ACCOUNT   | DAY#<yyyy-mm-dd>       account-wide spend for the day
 *   outbox    U#<owner> | EVT#<iso>#<eventId>    events; GSI1 PENDING#<shard> until dispatched
 */

export type Tables = {
  jobs: string;
  sessions: string;
  quotas: string;
  outbox: string;
};

export type Db = {
  client: DynamoDBDocumentClient;
  tables: Tables;
};

export function createDb(options: {
  tables: Tables;
  region?: string;
  /** DynamoDB Local in CI and local runs; never set on deployed stages. */
  endpoint?: string;
}): Db {
  const raw = new DynamoDBClient({
    region: options.region ?? process.env.AWS_REGION ?? 'us-west-1',
    maxAttempts: 3,
    ...(options.endpoint
      ? {
          endpoint: options.endpoint,
          credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
        }
      : {}),
  });
  return {
    client: DynamoDBDocumentClient.from(raw, {
      marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
    }),
    tables: options.tables,
  };
}

/** Epoch seconds, the unit DynamoDB TTL reads. */
export const epochSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

export const fromEpochSeconds = (seconds: number) => new Date(seconds * 1000);

export const utcDay = (date: Date) => date.toISOString().slice(0, 10);

export const userKey = (ownerId: string) => `U#${ownerId}`;

/** An item is gone once its TTL passes, even before DynamoDB's background sweep removes it. */
export const isExpired = (item: { expiresAt?: number }, now: Date) =>
  typeof item.expiresAt === 'number' && item.expiresAt <= epochSeconds(now);

export type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

const CONFLICT_ATTEMPTS = 6;

/**
 * DynamoDB rejects (rather than queues) a transaction that touches an item another transaction is
 * writing, with reason TransactionConflict. Nothing was written, so it is safe to try again after a
 * short jittered pause. A failed condition is never retried: it is the answer.
 */
export async function transact(db: Db, items: TransactItem[]): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await db.client.send(new TransactWriteCommand({ TransactItems: items }));
      return;
    } catch (error) {
      const reasons =
        error instanceof TransactionCanceledException ? error.CancellationReasons : [];
      const conflict =
        reasons?.some((reason) => reason.Code === 'TransactionConflict') &&
        !reasons.some((reason) => reason.Code === 'ConditionalCheckFailed');
      if (!conflict || attempt >= CONFLICT_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 10 * 2 ** attempt * (0.5 + Math.random())),
      );
    }
  }
}
