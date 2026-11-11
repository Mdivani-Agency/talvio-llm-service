import { createHash } from 'crypto';

import { LIMITS } from '@talvio/llm-contracts';

import { sha256Hex, textArtifactKey, type BlobStore } from '../lib/blob';
import { removeDocumentObjects } from '../lib/documents';
import { RejectedDocumentError, rejectionMessage } from '../lib/extract/errors';
import { normalizeText } from '../lib/extract/text';
import {
  collectOcr,
  jobTag,
  parseJobTag,
  planOcr,
  type OcrClient,
  type OcrNotification,
} from '../lib/ocr';
import type { Logger } from '../lib/log';
import type { DocumentOutcome, DocumentRecord, DocumentWarning, Store } from '../lib/store';

/*
 * The two halves of asynchronous OCR. `startOcr` runs inside document validation: it checks the
 * product page limit, records the intent with a stable idempotency token, starts Textract, records
 * the provider job id and returns, so no Lambda waits. `completeOcr` runs from the completion
 * queue: duplicates and out-of-order notifications are ignored unless they match the operation the
 * document is waiting for, and a notification that arrives before the job id is stored is retried.
 */

export type OcrConfig = {
  client: OcrClient;
  topicArn: string;
  roleArn: string;
  /** Name of the quarantine bucket Textract reads the pinned object from. */
  bucket: string;
  /** Content types read by OCR (see config OCR_CONTENT_TYPES). */
  types: string[];
};

type Deps = { store: Store; blobs: BlobStore; logger: Logger };

export const OCR_EXTRACTOR_VERSION = 'textract-text-1';

/** The provider token is derived from the document and the pinned version, never random. */
export const ocrClientToken = (document: Pick<DocumentRecord, 'documentId' | 'objectVersionId'>) =>
  createHash('sha256')
    .update(`${document.documentId}:${document.objectVersionId ?? ''}`)
    .digest('hex')
    .slice(0, 64);

export type StartResult = 'started' | 'rejected';

/** Starts text detection for a document with `pages` pages. Throws RejectedDocumentError over the limit. */
export async function startOcr(
  deps: Deps,
  config: OcrConfig,
  document: DocumentRecord,
  pages: number,
): Promise<StartResult> {
  planOcr(Array.from({ length: pages }, (_, n) => n + 1));
  const clientToken = ocrClientToken(document);
  // A repeat finds the intent already recorded; the same token then returns the same operation.
  await deps.store.documents.beginOcr(document.ownerId, document.documentId, {
    clientToken,
    pages,
  });
  const { jobId } = await config.client.start({
    source: {
      bucket: config.bucket,
      key: document.objectKey,
      versionId: document.objectVersionId,
    },
    clientToken,
    jobTag: jobTag(document.ownerId, document.documentId),
    notification: { topicArn: config.topicArn, roleArn: config.roleArn },
  });
  await deps.store.documents.recordOcrJob(
    document.ownerId,
    document.documentId,
    clientToken,
    jobId,
  );
  return 'started';
}

export type CompleteResult = 'ready' | 'rejected' | 'skipped' | 'retry';

const warn = (code: string, message: string): DocumentWarning => ({ code, message });

export async function completeOcr(
  deps: Deps,
  client: OcrClient,
  notification: OcrNotification,
  now: Date,
): Promise<CompleteResult> {
  const tag = notification.tag ? parseJobTag(notification.tag) : null;
  if (!tag) return 'skipped';
  const document = await deps.store.documents.get(tag.ownerId, tag.documentId);
  if (!document || document.status !== 'validating' || !document.ocr) return 'skipped';
  if (document.ocr.textractJobId === null) {
    // The notification beat our own bookkeeping: let SQS bring it back.
    return 'retry';
  }
  if (document.ocr.textractJobId !== notification.jobId) return 'skipped';

  if (notification.status === 'FAILED') {
    await deps.store.documents.finish(
      document.ownerId,
      document.documentId,
      {
        kind: 'rejected',
        code: 'unusable_document',
        warnings: [warn('ocr_failed', 'The text could not be recognized. Upload a clearer file.')],
      },
      now,
    );
    return 'rejected';
  }

  const result = await collectOcr(client, notification.jobId, document.ocr.pages);
  if (result.status === 'IN_PROGRESS') return 'retry';
  const warnings: DocumentWarning[] = [];
  if (result.status === 'FAILED') {
    return finishRejected(deps, document, now, [
      warn('ocr_failed', 'The text could not be recognized.'),
    ]);
  }
  if (result.missingPages.length > 0) {
    warnings.push(
      warn(
        'ocr_pages_missing',
        `${result.missingPages.length} page${result.missingPages.length === 1 ? ' was' : 's were'} not recognized and ${result.missingPages.length === 1 ? 'is' : 'are'} not in the text.`,
      ),
    );
  }
  if (result.status === 'PARTIAL_SUCCESS' || result.warnings.length > 0) {
    warnings.push(warn('ocr_partial', 'Some text may be missing or misread.'));
  }

  let text: string;
  try {
    text = normalizeText(result.pages.map((page) => page.lines.join('\n')).join('\n\n'));
  } catch (error) {
    if (error instanceof RejectedDocumentError) {
      return finishRejected(deps, document, now, [
        warn(error.reason, rejectionMessage(error.reason)),
      ]);
    }
    throw error;
  }

  const key = textArtifactKey(document.ownerId, document.documentId);
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      method: 'ocr',
      extractorVersion: OCR_EXTRACTOR_VERSION,
      text,
      pages: result.pages.map((page) => page.page),
    }),
  );
  const versionId = await deps.blobs.write('artifacts', key, body, 'application/json');
  const outcome: DocumentOutcome = {
    kind: 'ready',
    pageCount: document.ocr.pages,
    ocrPages: result.pages.map((page) => page.page).slice(0, LIMITS.pdfPages),
    warnings,
    artifact: {
      key,
      versionId,
      sha256: sha256Hex(Buffer.from(text, 'utf8')),
      chars: text.length,
      bytes: Buffer.byteLength(text, 'utf8'),
      extractorVersion: OCR_EXTRACTOR_VERSION,
      method: 'ocr',
    },
  };
  const finished = await deps.store.documents.finish(
    document.ownerId,
    document.documentId,
    outcome,
    now,
  );
  if (!finished) {
    // Deleted or finished by a duplicate while we read the pages: leave nothing behind.
    await removeDocumentObjects(deps, {
      objectKey: document.objectKey,
      artifact: outcome.artifact,
    });
    return 'skipped';
  }
  return 'ready';
}

async function finishRejected(
  deps: Deps,
  document: DocumentRecord,
  now: Date,
  warnings: DocumentWarning[],
): Promise<CompleteResult> {
  await deps.store.documents.finish(
    document.ownerId,
    document.documentId,
    { kind: 'rejected', code: 'unusable_document', warnings },
    now,
  );
  return 'rejected';
}
