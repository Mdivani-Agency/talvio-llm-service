import { LIMITS } from '@talvio/llm-contracts';

import { ObjectTooLargeError, sha256Hex, textArtifactKey, type BlobStore } from '../lib/blob';
import { removeDocumentObjects } from '../lib/documents';
import { extractDocx } from '../lib/extract/docx';
import { RejectedDocumentError, rejectionMessage, type RejectReason } from '../lib/extract/errors';
import { inspectPdf } from '../lib/extract/pdf';
import { startOcr, type OcrConfig } from './ocr';
import type { Logger } from '../lib/log';
import type { WorkMessage } from '../lib/queue';
import type {
  DocumentOutcome,
  DocumentRecord,
  DocumentRejection,
  DocumentWarning,
  Store,
} from '../lib/store';

/*
 * Document validation (design §8): runs from a `document.validate` message, independently of any
 * paid job. It reads exactly the object version pinned at completion, checks size and SHA-256 of
 * the bytes it actually read, then extracts text deterministically. A document is `ready` only
 * after all of that succeeded; every failure is a typed, actionable rejection with a fixed
 * message. Transient errors (storage unavailable) are thrown so SQS redelivers the message, and a
 * repeat of a finished document does nothing.
 */

export type DocumentResult = 'ready' | 'rejected' | 'waiting' | 'skipped' | 'gone';

type Deps = { store: Store; blobs: BlobStore; logger: Logger; ocr?: OcrConfig };

const CODES: Record<RejectReason, DocumentRejection> = {
  not_docx: 'unusable_document',
  malformed: 'unusable_document',
  encrypted: 'unusable_document',
  unsafe: 'unusable_document',
  too_large: 'payload_too_large',
  too_long: 'unusable_document',
  empty: 'unusable_document',
  checksum_mismatch: 'checksum_mismatch',
  unsupported_type: 'unsupported_media_type',
  ocr_page_limit: 'unusable_document',
};

const rejection = (reason: RejectReason): DocumentOutcome => ({
  kind: 'rejected',
  code: CODES[reason],
  warnings: [{ code: reason, message: rejectionMessage(reason) }],
});

export async function validateDocument(
  deps: Deps,
  message: Pick<WorkMessage, 'ownerId' | 'jobId'>,
  now: Date,
): Promise<DocumentResult> {
  const documentId = message.jobId;
  const document = await deps.store.documents.get(message.ownerId, documentId);
  if (!document) return 'gone';
  if (document.status !== 'validating') return 'skipped';

  const outcome = await judge(deps, document);
  if (outcome.kind === 'waiting') {
    // Parked on Textract: the completion consumer finishes the document, and no worker is held.
    return 'waiting';
  }
  const finished = await deps.store.documents.finish(message.ownerId, documentId, outcome, now);
  if (!finished) {
    // Deleted (or finished by a duplicate) while we worked: never leave our artifact behind.
    if (outcome.kind === 'ready') {
      await removeDocumentObjects(deps, {
        objectKey: document.objectKey,
        artifact: outcome.artifact,
      });
    }
    return 'gone';
  }
  deps.logger.log('info', {
    event: 'document_validated',
    outcome: outcome.kind,
    reason: outcome.kind === 'rejected' ? outcome.code : undefined,
  });
  return outcome.kind;
}

async function judge(
  deps: Deps,
  document: DocumentRecord,
): Promise<DocumentOutcome | { kind: 'waiting' }> {
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.blobs.read(
      'quarantine',
      document.objectKey,
      document.objectVersionId,
      LIMITS.uploadBytes,
    );
  } catch (error) {
    if (error instanceof ObjectTooLargeError) return rejection('too_large');
    throw error;
  }
  if (!bytes) return rejection('malformed');
  if (bytes.length !== document.sizeBytes || sha256Hex(bytes) !== document.sha256) {
    return rejection('checksum_mismatch');
  }

  try {
    if (deps.ocr?.types.includes(document.contentType)) {
      const pages = document.contentType === 'application/pdf' ? inspectPdf(bytes).pages : 1;
      await startOcr(deps, deps.ocr, document, pages);
      return { kind: 'waiting' };
    }
    if (document.contentType === 'application/pdf') {
      return pdfOutcome(bytes);
    }
    return await docxOutcome(deps, document, bytes);
  } catch (error) {
    if (error instanceof RejectedDocumentError) return rejection(error.reason);
    throw error;
  }
}

/**
 * PDFs are read in the browser (pdfjs-dist) and submitted as text; the service neither extracts
 * nor OCRs an uploaded PDF. It still judges the file, so an unsafe one is named as such.
 */
function pdfOutcome(bytes: Uint8Array): DocumentOutcome {
  inspectPdf(bytes); // throws RejectedDocumentError for encrypted, XFA or malformed files
  const warnings: DocumentWarning[] = [
    {
      code: 'pdf_browser_extraction',
      message:
        'PDF text is read in your browser. Submit the extracted text with your request instead of the file.',
    },
  ];
  return { kind: 'rejected', code: 'unusable_document', warnings };
}

async function docxOutcome(
  deps: Deps,
  document: DocumentRecord,
  bytes: Uint8Array,
): Promise<DocumentOutcome> {
  const extraction = extractDocx(bytes);
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      method: 'docx',
      extractorVersion: extraction.extractorVersion,
      text: extraction.text,
      paragraphs: extraction.paragraphs,
      tables: extraction.tables,
    }),
  );
  const key = textArtifactKey(document.ownerId, document.documentId);
  const versionId = await deps.blobs.write('artifacts', key, body, 'application/json');
  return {
    kind: 'ready',
    pageCount: null,
    ocrPages: [],
    warnings: extraction.warnings,
    artifact: {
      key,
      versionId,
      sha256: sha256Hex(Buffer.from(extraction.text, 'utf8')),
      chars: extraction.text.length,
      bytes: Buffer.byteLength(extraction.text, 'utf8'),
      extractorVersion: extraction.extractorVersion,
      method: 'docx',
    },
  };
}
