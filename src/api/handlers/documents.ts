import {
  LIMITS,
  createDocumentRequestSchema,
  documentContentTypeEnum,
  createDocumentResponseSchema,
  documentSchema,
} from '@talvio/llm-contracts';

import { ApiError, notFound } from '@lib/errors';
import type { DocumentRecord } from '@lib/store';
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
    rejectionCode: null,
    warnings: [],
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

export const createDocument: RouteHandler = async (request, deps) => {
  checkFile(request.body);
  const body = parseWith(createDocumentRequestSchema, request.body);
  const document = await deps.store.documents.create(userOf(request), body, request.now);
  const upload = await deps.store.uploads.create(document, request.now);
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

/** Pins the upload and queues validation. Runs no OCR or model. */
export const completeDocument: RouteHandler = async (request, deps) => {
  const document = await deps.store.documents.complete(
    userOf(request),
    request.params.documentId ?? '',
    request.now,
  );
  if (!document) {
    throw notFound();
  }
  return { status: 202, body: toDocument(document) };
};

export const deleteDocument: RouteHandler = async (request, deps) => {
  if (!(await deps.store.documents.delete(userOf(request), request.params.documentId ?? ''))) {
    throw notFound();
  }
  return { status: 204 };
};
