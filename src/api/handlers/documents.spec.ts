import { strToU8, zipSync } from 'fflate';

import { sha256Hex } from '../../lib/blob';
import { USER_A, USER_B, event, json, testApp, type TestApp } from '../../test/helpers';

const j = (body: string) => json(body) as Record<string, any>;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function docxBytes(text = 'Nino Beridze') {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });
}

describe('documents', () => {
  let app: TestApp;
  let tokenA: string;
  let tokenB: string;

  beforeEach(async () => {
    app = await testApp();
    tokenA = await app.tokenFor(USER_A);
    tokenB = await app.tokenFor(USER_B);
  });

  const register = (bytes: Uint8Array, contentType = DOCX, token = tokenA) =>
    app.handle(
      event('POST', '/v1/documents', {
        token,
        body: {
          schemaVersion: '1.0',
          fileName: 'cv.docx',
          contentType,
          sizeBytes: bytes.length,
          sha256: sha256Hex(bytes),
        },
      }),
    );
  const complete = (documentId: string, token = tokenA) =>
    app.handle(
      event('POST', '/v1/documents/{documentId}/complete', { params: { documentId }, token }),
    );
  const fetchDoc = (documentId: string, token = tokenA) =>
    app.handle(event('GET', '/v1/documents/{documentId}', { params: { documentId }, token }));

  /** Registers and uploads a file the way a client would, returning the document id and key. */
  async function upload(bytes: Uint8Array, contentType = DOCX) {
    const created = j((await register(bytes, contentType)).body);
    const key = await keyOf(created.document.documentId);
    app.blobs.upload(key, bytes, contentType);
    return { documentId: created.document.documentId as string, key };
  }
  const keyOf = async (documentId: string) =>
    (await app.store.documents.get(USER_A, documentId))?.objectKey ?? '';

  it('registers an upload and returns a grant bound to type, size and checksum', async () => {
    const bytes = docxBytes();
    const response = await register(bytes);
    expect(response.statusCode).toBe(201);
    const body = j(response.body);
    expect(body).toMatchObject({
      document: { status: 'awaiting_upload', contentType: DOCX },
      upload: { method: 'PUT' },
    });
    expect(body.upload.headers['x-amz-checksum-sha256']).toBe(
      Buffer.from(sha256Hex(bytes), 'hex').toString('base64'),
    );
    expect(body.upload.headers['content-type']).toBe(DOCX);
    expect(body.upload.url).toMatch(new RegExp(`pending/${USER_A}/`));
    // The key is random and never contains the file name.
    expect(body.upload.url).not.toContain('cv.docx');
  });

  it('rejects unsupported types and oversized files', async () => {
    const msword = await register(docxBytes(), 'application/msword');
    expect(msword.statusCode).toBe(415);
    const big = await app.handle(
      event('POST', '/v1/documents', {
        token: tokenA,
        body: {
          schemaVersion: '1.0',
          fileName: 'x.docx',
          contentType: DOCX,
          sizeBytes: 10 * 1024 * 1024 + 1,
          sha256: 'b'.repeat(64),
        },
      }),
    );
    expect(big.statusCode).toBe(413);
  });

  it('refuses completion before the file is uploaded', async () => {
    const { document } = j((await register(docxBytes())).body);
    const response = await complete(document.documentId);
    expect(response.statusCode).toBe(400);
    expect(j(response.body).error.message).toContain('not been uploaded');
  });

  it('refuses a file that is not the one declared', async () => {
    const declared = docxBytes('one');
    const created = j((await register(declared)).body);
    app.blobs.upload(await keyOf(created.document.documentId), docxBytes('different'), DOCX);
    const response = await complete(created.document.documentId);
    expect(response.statusCode).toBe(422);
    expect((await fetchDoc(created.document.documentId)).statusCode).toBe(200);
    expect(j((await fetchDoc(created.document.documentId)).body).status).toBe('awaiting_upload');
  });

  it('pins the uploaded version and queues validation once, for the owner only', async () => {
    const { documentId } = await upload(docxBytes());
    expect((await complete(documentId, tokenB)).statusCode).toBe(404);
    const first = await complete(documentId);
    expect(first.statusCode).toBe(202);
    expect(j(first.body).status).toBe('validating');
    expect(j((await complete(documentId)).body).status).toBe('validating');
    expect(app.queues.sent.filter((m) => m.message.type === 'document.validate')).toHaveLength(1);
    expect(app.queues.sent[0]?.message).toMatchObject({ ownerId: USER_A, jobId: documentId });
  });

  it('ignores an object swapped in after completion', async () => {
    const { documentId, key } = await upload(docxBytes('accepted'));
    await complete(documentId);
    const pinned = (await app.store.documents.get(USER_A, documentId))?.objectVersionId;
    app.blobs.upload(key, docxBytes('swapped'), DOCX);
    expect((await app.store.documents.get(USER_A, documentId))?.objectVersionId).toBe(pinned);
    expect(await app.blobs.read('quarantine', key, pinned ?? null, 1_000_000)).toEqual(
      docxBytes('accepted'),
    );
  });

  it('keeps accepting the document when the queue is down', async () => {
    const { documentId } = await upload(docxBytes());
    app.queues.failNext = 1;
    expect((await complete(documentId)).statusCode).toBe(202);
    const pending = await app.store.outbox.pending(10, new Date());
    expect(pending.some((e) => e.type === 'document.validate' && e.jobId === documentId)).toBe(
      true,
    );
  });

  it('deletes the record and its objects, and hides it from everyone', async () => {
    const { documentId, key } = await upload(docxBytes());
    await complete(documentId);
    const del = (token: string) =>
      app.handle(event('DELETE', '/v1/documents/{documentId}', { params: { documentId }, token }));
    expect((await del(tokenB)).statusCode).toBe(404);
    expect((await del(tokenA)).statusCode).toBe(204);
    expect(app.blobs.keys('quarantine')).not.toContain(key);
    expect((await fetchDoc(documentId)).statusCode).toBe(404);
    expect((await complete(documentId)).statusCode).toBe(404);
    expect((await del(tokenA)).statusCode).toBe(404);
  });
});
