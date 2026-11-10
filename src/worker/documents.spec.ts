import { randomUUID } from 'crypto';

import { strToU8, zipSync } from 'fflate';

import { createMemoryBlobs, sha256Hex, ObjectTooLargeError } from '../lib/blob';
import { createLogger } from '../lib/log';
import { createMemoryStore, type MemoryStore } from '../lib/store/memory';
import { validateDocument } from './documents';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const OWNER = randomUUID();
const NOW = new Date('2026-11-10T12:00:00.000Z');

const docx = (text: string, extra: Record<string, Uint8Array> = {}) =>
  zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
    ...extra,
  });

describe('validateDocument', () => {
  let store: MemoryStore;
  let blobs: ReturnType<typeof createMemoryBlobs>;
  const logs: string[] = [];
  const logger = createLogger('debug', (line) => logs.push(line));
  const deps = () => ({ store, blobs, logger });

  beforeEach(() => {
    store = createMemoryStore();
    blobs = createMemoryBlobs();
    logs.length = 0;
  });

  /** A document uploaded and completed the way the API does it. */
  async function pending(bytes: Uint8Array, declared = bytes, contentType = DOCX) {
    const key = `pending/${OWNER}/${randomUUID()}`;
    const document = await store.documents.create(
      OWNER,
      {
        schemaVersion: '1.0',
        fileName: 'cv',
        contentType: contentType as never,
        sizeBytes: declared.length,
        sha256: sha256Hex(declared),
      },
      key,
      NOW,
    );
    const versionId = blobs.upload(key, bytes, contentType);
    await store.documents.complete(OWNER, document.documentId, { versionId }, NOW);
    return { document, key, versionId };
  }
  const run = (documentId: string) =>
    validateDocument(deps(), { ownerId: OWNER, jobId: documentId }, NOW);
  const get = (documentId: string) => store.documents.get(OWNER, documentId);

  it('extracts a DOCX into a pinned private text artifact and marks it ready', async () => {
    const { document } = await pending(docx('Nino Beridze'));
    expect(await run(document.documentId)).toBe('ready');
    const ready = await get(document.documentId);
    expect(ready).toMatchObject({ status: 'ready', rejectionCode: null });
    expect(ready?.artifact).toMatchObject({
      method: 'docx',
      chars: 'Nino Beridze'.length,
      sha256: sha256Hex(Buffer.from('Nino Beridze')),
    });
    const stored = await blobs.read(
      'artifacts',
      ready?.artifact?.key ?? '',
      ready?.artifact?.versionId ?? null,
      1_000_000,
    );
    expect(JSON.parse(Buffer.from(stored ?? []).toString())).toMatchObject({
      text: 'Nino Beridze',
      extractorVersion: ready?.artifact?.extractorVersion,
    });
    // Artifacts live under the owner's results prefix, never in the upload bucket.
    expect(ready?.artifact?.key).toMatch(new RegExp(`^results/${OWNER}/`));
  });

  it('reports what it could not read as warnings', async () => {
    const { document } = await pending(docx('x', { 'word/media/a.png': strToU8('png') }));
    await run(document.documentId);
    expect((await get(document.documentId))?.warnings.map((w) => w.code)).toEqual([
      'docx_images_not_read',
    ]);
  });

  it('reads the pinned version even if the object was replaced afterwards', async () => {
    const { document, key } = await pending(docx('accepted'));
    blobs.upload(key, docx('swapped in later'), DOCX);
    expect(await run(document.documentId)).toBe('ready');
    const stored = await blobs.read(
      'artifacts',
      (await get(document.documentId))?.artifact?.key ?? '',
      null,
      1_000_000,
    );
    expect(Buffer.from(stored ?? []).toString()).toContain('accepted');
    expect(Buffer.from(stored ?? []).toString()).not.toContain('swapped');
  });

  it('rejects bytes that do not match the declared checksum', async () => {
    const { document } = await pending(docx('real'), docx('declared different'));
    expect(await run(document.documentId)).toBe('rejected');
    expect(await get(document.documentId)).toMatchObject({
      status: 'rejected',
      rejectionCode: 'checksum_mismatch',
    });
    expect(blobs.keys('artifacts')).toEqual([]);
  });

  it.each([
    ['a macro document', docx('x', { 'word/vbaProject.bin': strToU8('x') }), 'unsafe'],
    ['a text file', strToU8('plain text, not a docx'), 'not_docx'],
    ['an empty document', docx('   '), 'empty'],
  ])('rejects %s with an actionable message', async (_name, bytes, code) => {
    const { document } = await pending(bytes);
    expect(await run(document.documentId)).toBe('rejected');
    const rejected = await get(document.documentId);
    expect(rejected).toMatchObject({ status: 'rejected', rejectionCode: 'unusable_document' });
    expect(rejected?.warnings).toEqual([{ code, message: expect.stringMatching(/\.$/) }]);
    expect(JSON.stringify(rejected?.warnings)).not.toContain('plain text');
  });

  it('does not send PDFs anywhere: it judges them and points to browser extraction', async () => {
    const pdf = strToU8('%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n%%EOF');
    const { document } = await pending(pdf, pdf, 'application/pdf');
    expect(await run(document.documentId)).toBe('rejected');
    expect((await get(document.documentId))?.warnings[0]?.code).toBe('pdf_browser_extraction');

    const encrypted = strToU8(
      '%PDF-1.7\n1 0 obj << /Type /Page >> endobj\ntrailer << /Encrypt 5 0 R >>',
    );
    const { document: locked } = await pending(encrypted, encrypted, 'application/pdf');
    await run(locked.documentId);
    expect((await get(locked.documentId))?.warnings[0]?.code).toBe('encrypted');
  });

  it('does nothing for a missing, finished or repeated document', async () => {
    expect(await run(randomUUID())).toBe('gone');
    const { document } = await pending(docx('once'));
    expect(await run(document.documentId)).toBe('ready');
    expect(await run(document.documentId)).toBe('skipped');
    expect(blobs.keys('artifacts')).toHaveLength(1);
  });

  it('removes its artifact when the document was deleted while it worked', async () => {
    const { document } = await pending(docx('gone soon'));
    const original = store.documents.finish.bind(store.documents);
    store.documents.finish = async (...args) => {
      await store.documents.delete(OWNER, document.documentId);
      return original(...args);
    };
    expect(await run(document.documentId)).toBe('gone');
    expect(blobs.keys('artifacts')).toEqual([]);
  });

  it('lets storage failures through so the message is redelivered', async () => {
    const { document } = await pending(docx('retry me'));
    blobs.read = async () => {
      throw new Error('S3 unavailable');
    };
    await expect(run(document.documentId)).rejects.toThrow('S3 unavailable');
    expect((await get(document.documentId))?.status).toBe('validating');
  });

  it('rejects an object that is larger than the limit', async () => {
    const { document } = await pending(docx('big'));
    blobs.read = async () => {
      throw new ObjectTooLargeError();
    };
    expect(await run(document.documentId)).toBe('rejected');
    expect((await get(document.documentId))?.rejectionCode).toBe('payload_too_large');
  });

  it('logs content-free outcomes only', async () => {
    const { document } = await pending(docx('Secret résumé text'));
    await run(document.documentId);
    expect(logs.join('\n')).not.toContain('Secret');
  });
});
