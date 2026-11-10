import { randomUUID } from 'crypto';

import type { SQSEvent } from 'aws-lambda';
import type { CreateJobRequest } from '@talvio/llm-contracts';

import { DISPATCH_GRACE_MS } from '../lib/execution';
import { createLogger } from '../lib/log';
import { strToU8, zipSync } from 'fflate';

import { createMemoryBlobs, sha256Hex } from '../lib/blob';
import { createMemoryQueues, dispatchEvent, toWorkMessage, type WorkMessage } from '../lib/queue';
import { createMemoryStore, type MemoryStore } from '../lib/store/memory';
import {
  createDeadLetterHandler,
  createDispatcher,
  createOcrHandler,
  createReconciler,
  createWorkerHandler,
} from './handlers';
import type { Executor } from './run';

const OWNER = randomUUID();
const START = new Date('2026-11-10T12:00:00.000Z');

const sqs = (...bodies: string[]): SQSEvent =>
  ({
    Records: bodies.map((body, i) => ({ messageId: `m${i}`, body })),
  }) as SQSEvent;

describe('background handlers', () => {
  let store: MemoryStore;
  let queues: ReturnType<typeof createMemoryQueues>;
  let blobs: ReturnType<typeof createMemoryBlobs>;
  let clock: Date;
  const logger = createLogger('error', () => undefined);
  const now = () => clock;

  const admit = async (key: string) =>
    store.jobs.admit({
      ownerId: OWNER,
      plan: 'free',
      pipelineReleaseId: 'v1',
      idempotencyKey: key,
      requestHash: key,
      request: {
        schemaVersion: '1.0',
        clientRequestId: key,
        operation: 'parse_document',
        input: { kind: 'text', text: 't', extraction: null },
      } as CreateJobRequest,
      now: clock,
      deadlineAt: new Date(clock.getTime() + 600_000),
    });
  const body = (jobId: string): string =>
    JSON.stringify({
      v: 1,
      type: 'job.admitted',
      ownerId: OWNER,
      jobId,
      eventId: randomUUID(),
    } satisfies WorkMessage);
  const tick = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  beforeEach(() => {
    store = createMemoryStore();
    queues = createMemoryQueues();
    blobs = createMemoryBlobs();
    clock = START;
  });

  describe('worker', () => {
    const ok: Executor = async () => ({ kind: 'succeeded', result: 1, spendMicroUsd: 0 });

    it('runs the job named by a message', async () => {
      const { job } = await admit('key-00000001');
      const handle = createWorkerHandler({
        store,
        blobs,
        executors: { parse_document: ok },
        logger,
        now,
      });
      expect(await handle(sqs(body(job.jobId)))).toEqual({ batchItemFailures: [] });
      expect(await store.jobs.get(OWNER, job.jobId)).toMatchObject({ status: 'succeeded' });
    });

    it('acknowledges messages it cannot read instead of retrying them', async () => {
      const handle = createWorkerHandler({ store, blobs, executors: {}, logger, now });
      expect(await handle(sqs('not json', '{"v":2}', JSON.stringify({ v: 1 })))).toEqual({
        batchItemFailures: [],
      });
    });

    it('reports only the messages that hit an infrastructure error', async () => {
      const { job } = await admit('key-00000001');
      const broken = {
        ...store,
        execution: {
          ...store.execution,
          claim: async () => {
            throw new Error('store down');
          },
        },
      } as MemoryStore;
      const handle = createWorkerHandler({ store: broken, blobs, executors: {}, logger, now });
      expect(await handle(sqs(body(job.jobId)))).toEqual({
        batchItemFailures: [{ itemIdentifier: 'm0' }],
      });
    });
  });

  describe('dispatcher', () => {
    const dispatcher = () => createDispatcher({ store, queues, currentRelease: 'v1', logger, now });

    it('sends each due event once and marks it dispatched', async () => {
      const { job } = await admit('key-00000001');
      expect(await dispatcher()()).toEqual({ dispatched: 1, failed: 0 });
      expect(queues.sent.map((s) => s.message.jobId)).toEqual([job.jobId]);
      expect(queues.sent[0]?.releaseId).toBe('v1');
      expect(await dispatcher()()).toEqual({ dispatched: 0, failed: 0 });
    });

    it('leaves events pending when the queue is down, and sends them on the next run', async () => {
      await admit('key-00000001');
      queues.failNext = 1;
      expect(await dispatcher()()).toEqual({ dispatched: 0, failed: 1 });
      expect(queues.sent).toHaveLength(0);
      expect(await dispatcher()()).toEqual({ dispatched: 1, failed: 0 });
    });

    it('repairs a lost acknowledgment: a send that succeeded but was never marked is sent again', async () => {
      const { job, event } = await admit('key-00000001');
      // The immediate dispatch sent the message, then the function died before marking it.
      await queues.send('v1', {
        v: 1,
        type: 'job.admitted',
        ownerId: OWNER,
        jobId: job.jobId,
        eventId: event!.eventId,
      });
      await dispatcher()();
      expect(queues.sent).toHaveLength(2);
      // Both copies are harmless: the second finds the job leased or finished.
      const worker = createWorkerHandler({
        store,
        blobs,
        executors: {
          parse_document: async () => ({ kind: 'succeeded', result: 1, spendMicroUsd: 0 }),
        },
        logger,
        now,
      });
      await worker(sqs(...queues.sent.map((s) => JSON.stringify(s.message))));
      expect(await store.jobs.get(OWNER, job.jobId)).toMatchObject({ status: 'succeeded' });
    });

    it('holds a retry back until it is due', async () => {
      const { job } = await admit('key-00000001');
      const claim = await store.execution.claim(OWNER, job.jobId, clock, 60_000);
      if (claim.kind !== 'claimed') throw new Error('expected a claim');
      await store.execution.retryLater(
        claim.lease,
        'inference',
        new Date(clock.getTime() + 30_000),
        clock,
      );
      await dispatcher()();
      expect(queues.sent.map((s) => s.message.type)).toEqual(['job.admitted']);
      tick(31_000);
      await dispatcher()();
      expect(queues.sent.map((s) => s.message.type)).toEqual(['job.admitted', 'job.retry']);
    });
  });

  describe('reconciler', () => {
    const reconcile = () => createReconciler({ store, logger, now })();

    it('leaves recent work alone', async () => {
      await admit('key-00000001');
      expect(await reconcile()).toMatchObject({ requeued: 0, expired: 0 });
    });

    it('keeps sweeping when one job throws', async () => {
      await admit('key-00000001');
      await admit('key-00000002');
      tick(DISPATCH_GRACE_MS + 1_000);
      const original = store.execution.reconcile.bind(store.execution);
      let calls = 0;
      store.execution.reconcile = async (...args) => {
        calls += 1;
        if (calls === 1) throw new Error('boom: secret text');
        return original(...args);
      };
      expect(await reconcile()).toMatchObject({ failed: 1, requeued: 1 });
    });

    it('republishes work whose message was lost, so the job still runs', async () => {
      const { job } = await admit('key-00000001');
      // The enqueue acknowledgment was lost: the event was marked sent but no message exists.
      const [event] = await store.outbox.pending(10, clock);
      await store.outbox.markDispatched(event!, clock);
      tick(DISPATCH_GRACE_MS + 1_000);
      expect(await reconcile()).toMatchObject({ requeued: 1 });
      await createDispatcher({ store, queues, currentRelease: 'v1', logger, now })();
      expect(queues.sent.map((s) => s.message.type)).toEqual(['job.requeue']);
      const worker = createWorkerHandler({
        store,
        blobs,
        executors: {
          parse_document: async () => ({ kind: 'succeeded', result: 1, spendMicroUsd: 0 }),
        },
        logger,
        now,
      });
      await worker(sqs(JSON.stringify(queues.sent[0]?.message)));
      expect(await store.jobs.get(OWNER, job.jobId)).toMatchObject({ status: 'succeeded' });
    });

    it('expires a job past its deadline and frees its slot', async () => {
      const { job } = await admit('key-00000001');
      tick(11 * 60_000);
      expect(await reconcile()).toMatchObject({ expired: 1 });
      expect(await store.jobs.get(OWNER, job.jobId)).toMatchObject({
        status: 'expired',
        error: { code: 'deadline_exceeded' },
      });
      expect(await reconcile()).toMatchObject({ expired: 0, requeued: 0 });
    });
  });

  describe('dead letters', () => {
    it('ends the job visibly, retryable by its owner, and ignores unreadable messages', async () => {
      const { job } = await admit('key-00000001');
      const handle = createDeadLetterHandler({ store, logger, now });
      expect(await handle(sqs('garbage', body(job.jobId)))).toEqual({ batchItemFailures: [] });
      expect(await store.jobs.get(OWNER, job.jobId)).toMatchObject({
        status: 'failed',
        error: { code: 'internal_error', retryable: true },
      });
      // A second dead letter for the same job changes nothing.
      expect(await handle(sqs(body(job.jobId)))).toEqual({ batchItemFailures: [] });
      expect(await store.jobs.retry(OWNER, job.jobId, clock)).toMatchObject({ status: 'queued' });
    });

    it('does not touch another user’s job', async () => {
      const { job } = await admit('key-00000001');
      const stranger = JSON.stringify({
        v: 1,
        type: 'job.admitted',
        ownerId: randomUUID(),
        jobId: job.jobId,
        eventId: randomUUID(),
      });
      await createDeadLetterHandler({ store, logger, now })(sqs(stranger));
      expect(await store.jobs.get(OWNER, job.jobId)).toMatchObject({ status: 'queued' });
    });
  });

  describe('documents', () => {
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const bytes = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': strToU8(
        '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>',
      ),
    });

    async function validating() {
      const key = `pending/${OWNER}/${randomUUID()}`;
      const document = await store.documents.create(
        OWNER,
        {
          schemaVersion: '1.0',
          fileName: 'cv',
          contentType: DOCX,
          sizeBytes: bytes.length,
          sha256: sha256Hex(bytes),
        },
        key,
        clock,
      );
      const versionId = blobs.upload(key, bytes, DOCX);
      const completed = await store.documents.complete(
        OWNER,
        document.documentId,
        { versionId },
        clock,
      );
      return { document, event: completed!.event! };
    }

    it('validates a document end to end through the dispatcher and the worker', async () => {
      const { document, event } = await validating();
      expect(event.type).toBe('document.validate');
      await createDispatcher({ store, queues, currentRelease: 'v1', logger, now })();
      // Document work goes to the current release queue, with no content in the message.
      expect(queues.sent).toHaveLength(1);
      expect(queues.sent[0]?.releaseId).toBe('v1');
      const message = JSON.stringify(queues.sent[0]?.message);
      expect(message).not.toContain('Hello');
      const worker = createWorkerHandler({ store, blobs, executors: {}, logger, now });
      expect(await worker(sqs(message))).toEqual({ batchItemFailures: [] });
      expect(await store.documents.get(OWNER, document.documentId)).toMatchObject({
        status: 'ready',
      });
      // Redelivery of the same message is harmless.
      expect(await worker(sqs(message))).toEqual({ batchItemFailures: [] });
      expect(blobs.keys('artifacts')).toHaveLength(1);
    });

    it('returns a message to the queue when storage fails', async () => {
      const { document } = await validating();
      blobs.read = async () => {
        throw new Error('S3 unavailable');
      };
      const worker = createWorkerHandler({ store, blobs, executors: {}, logger, now });
      const result = await worker(
        sqs(JSON.stringify(toWorkMessage((await store.outbox.pending(1, clock))[0]!))),
      );
      expect(result.batchItemFailures).toHaveLength(1);
      expect((await store.documents.get(OWNER, document.documentId))?.status).toBe('validating');
    });

    it('ends a dead-lettered document visibly instead of leaving it validating', async () => {
      const { document, event } = await validating();
      const handle = createDeadLetterHandler({ store, logger, now });
      expect(await handle(sqs(JSON.stringify(toWorkMessage(event))))).toEqual({
        batchItemFailures: [],
      });
      expect(await store.documents.get(OWNER, document.documentId)).toMatchObject({
        status: 'rejected',
        rejectionCode: 'unusable_document',
      });
    });

    it('ignores OCR notifications when OCR is not configured, and unreadable ones', async () => {
      const handle = createOcrHandler({ store, blobs, logger, now });
      const good = JSON.stringify({ JobId: 'j', Status: 'SUCCEEDED', JobTag: 'a'.repeat(64) });
      expect(await handle(sqs('garbage', good))).toEqual({ batchItemFailures: [] });
    });
  });

  it('dispatches one event through dispatchEvent', async () => {
    const { event } = await admit('key-00000001');
    await dispatchEvent({ store, queues, currentRelease: 'v1' }, event!, clock);
    expect(queues.sent).toHaveLength(1);
    expect(await store.outbox.pending(10, clock)).toEqual([]);
  });
});
