import { z } from 'zod';

import { warningSchema } from './evidence';
import { LIMITS } from './limits';
import { isoDateTimeSchema, sha256Schema, uuidSchema } from './primitives';
import { schemaVersionSchema } from './version';

/*
 * Private document uploads (design §§6, 7). POST /documents returns a short-lived upload grant;
 * POST /documents/{id}/complete pins the uploaded object and starts deterministic validation and
 * extraction. Neither route runs OCR or a model. Plain text never needs an upload.
 */

export const documentContentTypeEnum = z.enum([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export const createDocumentRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  fileName: z.string().min(1).max(255),
  contentType: documentContentTypeEnum,
  sizeBytes: z.int().min(1).max(LIMITS.uploadBytes),
  sha256: sha256Schema,
});

export const uploadGrantSchema = z.strictObject({
  method: z.literal('PUT'),
  url: z.url({ protocol: /^https$/ }),
  /** Headers the upload must send unchanged (content type, checksum). */
  headers: z.record(z.string(), z.string()),
  expiresAt: isoDateTimeSchema,
});

export const documentStatusEnum = z.enum([
  'awaiting_upload',
  'validating',
  'ready',
  'rejected',
  'expired',
  'deleted',
]);

export const documentSchema = z.strictObject({
  documentId: uuidSchema,
  status: documentStatusEnum,
  contentType: documentContentTypeEnum,
  sizeBytes: z.int().min(1),
  pageCount: z.int().min(1).nullable(),
  /** Pages that need OCR before parsing; more than LIMITS.ocrPages rejects the parse. */
  ocrPages: z.array(z.int().min(1)).max(LIMITS.pdfPages),
  rejectionCode: z
    .enum(['unsupported_media_type', 'payload_too_large', 'unusable_document', 'checksum_mismatch'])
    .nullable(),
  warnings: z.array(warningSchema).max(50),
  createdAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
});

export const createDocumentResponseSchema = z.strictObject({
  document: documentSchema,
  upload: uploadGrantSchema,
});

export type CreateDocumentRequest = z.infer<typeof createDocumentRequestSchema>;
export type DocumentStatus = z.infer<typeof documentStatusEnum>;
export type DocumentRecord = z.infer<typeof documentSchema>;
