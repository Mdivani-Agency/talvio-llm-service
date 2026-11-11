import {
  SCHEMA_VERSION,
  resultEnvelopeSchemas,
  type JobError,
  type ParseDocumentInput,
  type ParseDocumentResult,
  type Warning,
} from '@talvio/llm-contracts';

import { sha256Hex, type BlobStore } from '../lib/blob';
import { contentHash } from '../lib/hash';
import type { Logger } from '../lib/log';
import type { Guardrail, ModelClient } from '../lib/model/client';
import { normalizeParse, type SourceMeta } from '../lib/parse/normalize';
import {
  PARSE_MODEL_ID,
  PARSE_PACK,
  PROMPT_VERSION,
  userMessage,
} from '../lib/prompts/parse-document';
import type { Store } from '../lib/store';
import { paidJob, Stop, stopping } from './paid';
import { TransientError, type Executor, type StepContext, type StepOutcome } from './run';

/*
 * parse_document (design §§9–11): read the admitted text, check it with the input guardrail, make
 * one bounded model call (plus at most one schema repair; see paid.ts), then ground and validate
 * the result.
 */

export type ParseDeps = {
  store: Store;
  blobs: BlobStore;
  model: ModelClient;
  guardrail: Guardrail;
  logger: Logger;
};

/** Largest text artifact read back for a document (100,000 characters as JSON). */
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

type Source = {
  text: string;
  meta: SourceMeta;
  extraction: ParseDocumentResult['extraction'];
  warnings: Warning[];
};

const failed = (code: JobError['code']): never => {
  throw new Stop({ kind: 'failed', code });
};

/**
 * Extraction warnings that mean some of the document's content never reached the text, so the
 * result cannot be complete. `docx_text_boxes_inline` is not one: that text was read.
 */
const OMISSION_WARNINGS = new Set([
  'ocr_pages_missing',
  'docx_images_not_read',
  'docx_embedded_objects_not_read',
]);

async function loadSource(
  deps: ParseDeps,
  ownerId: string,
  input: ParseDocumentInput,
): Promise<Source> {
  if (input.kind === 'text') {
    const pages = input.extraction?.pages ?? [];
    const review = pages.filter((page) => page.coverage !== 'text').map((page) => page.page);
    return {
      text: input.text,
      meta: { sourceHash: sha256Hex(Buffer.from(input.text, 'utf8')), clientSupplied: true, pages },
      extraction: {
        method: input.extraction ? 'client_pdf_text' : 'plain_text',
        ocrPages: 0,
        complete: review.length === 0,
        pagesNeedingReview: review,
      },
      warnings: review.map((page) => ({
        code: 'page_needs_review',
        message: 'Text on this page may be missing or unreadable. Check it against the original.',
        entityId: null,
        page,
      })),
    };
  }

  // The document must still be the caller's and ready; deletion revokes the job's access to it.
  const document = await deps.store.documents.get(ownerId, input.documentId);
  if (!document) return failed('revoked');
  if (document.status !== 'ready' || !document.artifact) return failed('unusable_document');
  const { artifact } = document;
  const bytes = await deps.blobs.read(
    'artifacts',
    artifact.key,
    artifact.versionId,
    MAX_ARTIFACT_BYTES,
  );
  if (!bytes) return failed('revoked');
  let text: unknown;
  try {
    text = (JSON.parse(Buffer.from(bytes).toString('utf8')) as { text?: unknown }).text;
  } catch {
    return failed('unusable_document');
  }
  // The artifact is pinned by hash as well as version: anything else is not what was accepted.
  if (typeof text !== 'string' || sha256Hex(Buffer.from(text, 'utf8')) !== artifact.sha256) {
    return failed('unusable_document');
  }
  const missing = document.warnings.some((warning) => OMISSION_WARNINGS.has(warning.code));
  return {
    text,
    meta: { sourceHash: artifact.sha256, clientSupplied: false, pages: [] },
    extraction: {
      method: artifact.method === 'docx' ? 'docx' : 'pdf_ocr',
      ocrPages: Math.min(document.ocrPages.length, 3),
      complete: !missing,
      pagesNeedingReview: [],
    },
    warnings: document.warnings
      .filter((warning) => /^[a-z][a-z0-9_]*$/.test(warning.code))
      .map((warning) => ({
        code: warning.code.slice(0, 64),
        message: warning.message.slice(0, 500),
        entityId: null,
        page: null,
      })),
  };
}

export function createParseExecutor(deps: ParseDeps): Executor {
  return (context) => stopping(() => run(deps, context));
}

async function run(deps: ParseDeps, context: StepContext): Promise<StepOutcome> {
  const { job } = context;
  const paid = paidJob(deps, context);
  const { spent, stop } = paid;

  const request = await deps.store.jobs.input(job.ownerId, job.jobId);
  if (!request || request.operation !== 'parse_document') return stop('revoked');
  let source: Source;
  try {
    source = await loadSource(deps, job.ownerId, request.input);
  } catch (error) {
    if (error instanceof Stop) throw new Stop(paid.withSpend(error.outcome));
    throw new TransientError('extraction');
  }
  const user = userMessage(source.text);

  await paid.guard(source.text, (available) => paid.planFor(PARSE_PACK, user, available));
  const output = await paid.infer(PARSE_PACK, user);
  return publish(job, request.input, source, output, spent());

  function publish(
    jobRecord: typeof job,
    input: ParseDocumentInput,
    from: Source,
    output: Parameters<typeof normalizeParse>[0],
    spendMicroUsd: number,
  ): StepOutcome {
    const normalized = normalizeParse(output, from.text, from.meta);
    const complete = normalized.complete && from.extraction.complete;
    const envelope = {
      jobId: jobRecord.jobId,
      schemaVersion: SCHEMA_VERSION,
      operation: 'parse_document' as const,
      inputHash: contentHash(input),
      contextRevisionId: null,
      contextHash: null,
      sourceRevision: null,
      versions: {
        pipelineReleaseId: jobRecord.exec.pipelineReleaseId,
        promptVersion: PROMPT_VERSION,
        modelId: PARSE_MODEL_ID,
      },
      resultKind: complete ? ('complete' as const) : ('partial' as const),
      warnings: [...from.warnings, ...normalized.warnings].slice(0, 100),
      result: {
        career: normalized.career,
        facts: normalized.facts,
        uncertainties: normalized.uncertainties,
        extraction: { ...from.extraction, complete: from.extraction.complete },
      },
    };
    const checked = resultEnvelopeSchemas.parse_document.safeParse(envelope);
    if (!checked.success) {
      deps.logger.log('error', {
        event: 'result_invalid',
        jobId: jobRecord.jobId,
        count: checked.error.issues.length,
      });
      return { kind: 'failed', code: 'validation_failed', spendMicroUsd };
    }
    return { kind: 'succeeded', result: checked.data, spendMicroUsd };
  }
}
