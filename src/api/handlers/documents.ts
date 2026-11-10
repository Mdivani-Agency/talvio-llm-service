import {
  LIMITS,
  createDocumentRequestSchema,
  documentContentTypeEnum,
  createDocumentResponseSchema,
  documentSchema,
} from '@talvio/llm-contracts';

import { hexToBase64, uploadKey } from '@lib/blob';
import { ApiError, notFound } from '@lib/errors';
import type { DocumentRecord } from '@lib/store';
import { removeDocumentObjects } from '@lib/documents';
import { parseWith } from '@lib/validation';

import { userOf, type RouteHandler } from '../types';

function toDocument(record: DocumentRecord) {
  return documentSchema.parse({
    documentId: record.documentId,
    status: record.status,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    pageCount: record.pageCount,
    ocrPages: record.ocrPages,
    rejectionCode: record.rejectionCode,
    warnings: record.warnings.map((warning) => ({ ...warning, entityId: null, page: null })),
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  });
}

/** Size and type get their own status codes (413, 415) before general validation. */
function checkFile(body: unknown) {
  const { sizeBytes, contentType } = (body ?? {}) as Record<string, unknown>;
  if (typeof sizeBytes === 'number' && sizeBytes > LIMITS.uploadBytes) {
    throw new ApiError('payload_too_large', { message: 'Files can be at most 10 MB.' });
  }
  if (typeof contentType === 'string' && !documentContentTypeEnum.safeParse(contentType).success) {
    throw new ApiError('unsupported_media_type', { message: 'Upload a PDF or DOCX file.' });
  }
}

/** How long an upload grant is usable. The object itself is judged again at completion. */
const UPLOAD_GRANT_SECONDS = 300;

export const createDocument: RouteHandler = async (request, deps) => {
  checkFile(request.body);
  const body = parseWith(createDocumentRequestSchema, request.body);
  const ownerId = userOf(request);
  const document = await deps.store.documents.create(
    ownerId,
    body,
    uploadKey(ownerId),
    request.now,
  );
  const upload = await deps.blobs.grantUpload(
    {
      key: document.objectKey,
      contentType: document.contentType,
      sizeBytes: document.sizeBytes,
      sha256: document.sha256,
      expiresInSeconds: UPLOAD_GRANT_SECONDS,
    },
    request.now,
  );
  return {
    status: 201,
    body: createDocumentResponseSchema.parse({
      document: toDocument(document),
      upload: { ...upload, expiresAt: upload.expiresAt.toISOString() },
    }),
  };
};

export const getDocument: RouteHandler = async (request, deps) => {
  const document = await deps.store.documents.get(userOf(request), request.params.documentId ?? '');
  if (!document) {
    throw notFound();
  }
  return { status: 200, body: toDocument(document) };
};

const MISMATCH = 'The uploaded file does not match what was declared.';

/**
 * Pins the uploaded object version and queues deterministic validation. The object is looked up
 * here, so what is validated later is exactly the version seen now: replacing the object after
 * this point (a reused URL, an overwrite) changes nothing. Runs no OCR or model.
 */
export const completeDocument: RouteHandler = async (request, deps) => {
  const ownerId = userOf(request);
  const document = await deps.store.documents.get(ownerId, request.params.documentId ?? '');
  if (!document) {
    throw notFound();
  }
  if (document.status !== 'awaiting_upload') {
    return { status: 202, body: toDocument(document) };
  }
  const head = await deps.blobs.head('quarantine', document.objectKey);
  if (!head) {
    throw new ApiError('invalid_request', { message: 'The file has not been uploaded yet.' });
  }
  if (head.size > LIMITS.uploadBytes) {
    throw new ApiError('payload_too_large', { message: 'Files can be at most 10 MB.' });
  }
  const sameChecksum =
    head.checksumSha256 === null || head.checksumSha256 === hexToBase64(document.sha256);
  if (head.size !== document.sizeBytes || !sameChecksum) {
    throw new ApiError('unusable_document', { message: MISMATCH });
  }
  const completed = await deps.store.documents.complete(
    ownerId,
    document.documentId,
    { versionId: head.versionId },
    request.now,
  );
  if (!completed) {
    throw notFound();
  }
  if (completed.event) {
    try {
      await deps.dispatch(completed.event);
    } catch (error) {
      // The dispatcher sends it from the outbox shortly; the document is already pinned.
      deps.logger.log('warn', {
        event: 'dispatch_deferred',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return { status: 202, body: toDocument(completed.document) };
};

/** Revokes the document at once and removes its objects; anything still in flight finds it gone. */
export const deleteDocument: RouteHandler = async (request, deps) => {
  const removed = await deps.store.documents.delete(
    userOf(request),
    request.params.documentId ?? '',
  );
  if (!removed) {
    throw notFound();
  }
  await removeDocumentObjects(deps, removed);
  return { status: 204 };
};
