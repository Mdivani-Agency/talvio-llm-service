import { randomUUID } from 'crypto';

import { createMemoryBlobs, sha256Hex } from '../lib/blob';
import { RejectedDocumentError } from '../lib/extract/errors';
import { createLogger } from '../lib/log';
import { createMemoryOcr, jobTag, parseOcrNotification, type OcrNotification } from '../lib/ocr';
import { createMemoryStore, type MemoryStore } from '../lib/store/memory';
import { validateDocument } from './documents';
import { completeOcr, ocrClientToken, type OcrConfig } from './ocr';

const PDF = 'application/pdf';
const OWNER = randomUUID();
const NOW = new Date('2026-11-10T12:00:00.000Z');

const pdf = (pages: number) =>
  Buffer.from(
    `%PDF-1.7\n${Array.from({ length: pages }, (_, n) => `${n + 1} 0 obj << /Type /Page >> endobj`).join('\n')}\n%%EOF`,
  );

describe('asynchronous OCR', () => {
  let store: MemoryStore;
  let blobs: ReturnType<typeof createMemoryBlobs>;
  let client: ReturnType<typeof createMemoryOcr>;
  let config: OcrConfig;
  const logger = createLogger('error', () => undefined);

  beforeEach(() => {
    store = createMemoryStore();
    blobs = createMemoryBlobs();
    client = createMemoryOcr();
    config = {
      client,
      topicArn: 'arn:topic',
      roleArn: 'arn:role',
      bucket: 'quarantine',
      types: [PDF],
    };
  });

  async function pending(bytes: Uint8Array) {
    const key = `pending/${OWNER}/${randomUUID()}`;
    const document = await store.documents.create(
      OWNER,
      {
        schemaVersion: '1.0',
        fileName: 'x',
        contentType: PDF,
        sizeBytes: bytes.length,
        sha256: sha256Hex(bytes),
      },
      key,
      NOW,
    );
    const versionId = blobs.upload(key, bytes, PDF);
    await store.documents.complete(OWNER, document.documentId, { versionId }, NOW);
    return document;
  }
  const validate = (documentId: string, ocr: OcrConfig | null = config) =>
    validateDocument(
      { store, blobs, logger, ocr: ocr ?? undefined },
      { ownerId: OWNER, jobId: documentId },
      NOW,
    );
  const get = (id: string) => store.documents.get(OWNER, id);
  const notify = (
    documentId: string,
    jobId: string,
    status: OcrNotification['status'] = 'SUCCEEDED',
  ) => ({
    jobId,
    status,
    tag: jobTag(OWNER, documentId),
  });
  const script = (jobId: string, pages: Parameters<typeof client.scripts.set>[1]) =>
    client.scripts.set(jobId, pages);

  it('starts detection without waiting and records the provider job', async () => {
    const doc = await pending(pdf(2));
    expect(await validate(doc.documentId)).toBe('waiting');
    expect(client.started).toHaveLength(1);
    expect(client.started[0]).toMatchObject({
      jobTag: jobTag(OWNER, doc.documentId),
      source: { bucket: 'quarantine', key: doc.objectKey },
    });
    expect(await get(doc.documentId)).toMatchObject({
      status: 'validating',
      ocr: { state: 'started', textractJobId: 'job-1', pages: 2 },
    });
  });

  it('rejects more than three pages before any Textract call', async () => {
    const doc = await pending(pdf(4));
    expect(await validate(doc.documentId)).toBe('rejected');
    expect(client.started).toEqual([]);
    expect((await get(doc.documentId))?.warnings[0]).toMatchObject({ code: 'ocr_page_limit' });
  });

  it('sends nothing to Textract unless the type is configured', async () => {
    const doc = await pending(pdf(2));
    expect(await validate(doc.documentId, null)).toBe('rejected');
    expect(client.started).toEqual([]);
  });

  it('restarts with the same token after a crash and never starts a second operation', async () => {
    const doc = await pending(pdf(1));
    const record = await get(doc.documentId);
    await validate(doc.documentId);
    // A redelivered message runs the whole step again.
    await validate(doc.documentId);
    expect(client.started).toHaveLength(1);
    expect(client.started[0]?.clientToken).toBe(ocrClientToken(record!));
  });

  it('merges every result page in page order and finishes the document once', async () => {
    const doc = await pending(pdf(2));
    await validate(doc.documentId);
    script('job-1', [
      {
        status: 'SUCCEEDED',
        pages: [{ page: 2, lines: ['Page two line'] }],
        warnings: [],
        nextToken: null,
      },
      {
        status: 'SUCCEEDED',
        pages: [
          { page: 1, lines: ['Nino Beridze', 'Engineer'] },
          { page: 2, lines: ['Page two line', 'Second line'] },
        ],
        warnings: [],
        nextToken: null,
      },
    ]);
    const n = notify(doc.documentId, 'job-1');
    expect(await completeOcr({ store, blobs, logger }, client, n, NOW)).toBe('ready');
    const ready = await get(doc.documentId);
    expect(ready).toMatchObject({ status: 'ready', ocrPages: [1, 2], artifact: { method: 'ocr' } });
    const text = JSON.parse(
      Buffer.from(
        (await blobs.read('artifacts', ready?.artifact?.key ?? '', null, 1e6)) ?? [],
      ).toString(),
    ).text as string;
    expect(text).toBe('Nino Beridze\nEngineer\n\nPage two line\nSecond line');
    // A duplicate completion changes nothing.
    expect(await completeOcr({ store, blobs, logger }, client, n, NOW)).toBe('skipped');
  });

  it('reports pages Textract did not return instead of filling them in', async () => {
    const doc = await pending(pdf(3));
    await validate(doc.documentId);
    script('job-1', [
      {
        status: 'PARTIAL_SUCCESS',
        pages: [{ page: 1, lines: ['Only page one'] }],
        warnings: ['x'],
        nextToken: null,
      },
    ]);
    expect(
      await completeOcr({ store, blobs, logger }, client, notify(doc.documentId, 'job-1'), NOW),
    ).toBe('ready');
    const ready = await get(doc.documentId);
    expect(ready?.warnings.map((w) => w.code)).toEqual(['ocr_pages_missing', 'ocr_partial']);
    expect(ready?.warnings[0]?.message).toContain('2 pages were not recognized');
  });

  it('ignores a notification for another operation and retries one that comes too early', async () => {
    const doc = await pending(pdf(1));
    // Notification before the provider job id is stored (we only recorded intent).
    await store.documents.beginOcr(OWNER, doc.documentId, { clientToken: 't', pages: 1 });
    expect(
      await completeOcr({ store, blobs, logger }, client, notify(doc.documentId, 'job-1'), NOW),
    ).toBe('retry');
    await store.documents.recordOcrJob(OWNER, doc.documentId, 't', 'job-1');
    expect(
      await completeOcr({ store, blobs, logger }, client, notify(doc.documentId, 'job-OTHER'), NOW),
    ).toBe('skipped');
    expect((await get(doc.documentId))?.status).toBe('validating');
  });

  it('rejects on a failed operation and on a deleted document', async () => {
    const doc = await pending(pdf(1));
    await validate(doc.documentId);
    expect(
      await completeOcr(
        { store, blobs, logger },
        client,
        notify(doc.documentId, 'job-1', 'FAILED'),
        NOW,
      ),
    ).toBe('rejected');
    expect((await get(doc.documentId))?.warnings[0]?.code).toBe('ocr_failed');

    const gone = await pending(pdf(1));
    await validate(gone.documentId);
    await store.documents.delete(OWNER, gone.documentId);
    expect(
      await completeOcr({ store, blobs, logger }, client, notify(gone.documentId, 'job-2'), NOW),
    ).toBe('skipped');
    expect(blobs.keys('artifacts')).toEqual([]);
  });

  it('removes its artifact when the document disappears while pages are read', async () => {
    const doc = await pending(pdf(1));
    await validate(doc.documentId);
    script('job-1', [
      { status: 'SUCCEEDED', pages: [{ page: 1, lines: ['text'] }], warnings: [], nextToken: null },
    ]);
    const original = store.documents.finish.bind(store.documents);
    store.documents.finish = async (...args) => {
      await store.documents.delete(OWNER, doc.documentId);
      return original(...args);
    };
    expect(
      await completeOcr({ store, blobs, logger }, client, notify(doc.documentId, 'job-1'), NOW),
    ).toBe('skipped');
    expect(blobs.keys('artifacts')).toEqual([]);
  });

  it('rejects empty recognition instead of publishing nothing', async () => {
    const doc = await pending(pdf(1));
    await validate(doc.documentId);
    script('job-1', [{ status: 'SUCCEEDED', pages: [], warnings: [], nextToken: null }]);
    expect(
      await completeOcr({ store, blobs, logger }, client, notify(doc.documentId, 'job-1'), NOW),
    ).toBe('rejected');
    expect((await get(doc.documentId))?.warnings[0]?.code).toBe('empty');
  });
});

describe('OCR notifications', () => {
  const inner = { JobId: 'abc', Status: 'SUCCEEDED', JobTag: 'a'.repeat(64) };

  it('reads an SNS envelope and a bare message', () => {
    const expected = { jobId: 'abc', status: 'SUCCEEDED', tag: 'a'.repeat(64) };
    expect(parseOcrNotification(JSON.stringify({ Message: JSON.stringify(inner) }))).toEqual(
      expected,
    );
    expect(parseOcrNotification(JSON.stringify(inner))).toEqual(expected);
  });

  it('refuses anything else', () => {
    expect(parseOcrNotification('nope')).toBeNull();
    expect(parseOcrNotification(JSON.stringify({ JobId: 1 }))).toBeNull();
    expect(parseOcrNotification(JSON.stringify({ Message: 'not json' }))).toBeNull();
  });

  it('keeps the page limit error typed', () => {
    expect(new RejectedDocumentError('ocr_page_limit').reason).toBe('ocr_page_limit');
  });
});
