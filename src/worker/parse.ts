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
import {
  guardrailBound,
  guardrailChunks,
  nextEntry,
  planCall,
  reserved,
  settled,
  spentMicroUsd,
  type Ledger,
} from '../lib/model/budget';
import {
  ProviderRejectedError,
  ProviderUnavailableError,
  type Guardrail,
  type ModelClient,
  type ModelMessage,
} from '../lib/model/client';
import {
  guardrailCostMicroUsd,
  guardrailUnits,
  modelCostMicroUsd,
  UnpricedModelError,
} from '../lib/model/pricing';
import { normalizeParse, type SourceMeta } from '../lib/parse/normalize';
import {
  FIXED_REQUEST_BYTES,
  MODEL_TIMEOUT_MS,
  OUTPUT_TOKENS,
  PARSE_MODEL_ID,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  TOOL_SCHEMA,
  modelOutputSchema,
  repairMessage,
  userMessage,
} from '../lib/prompts/parse-document';
import type { JobStage, Store } from '../lib/store';
import { TransientError, type Executor, type StepContext, type StepOutcome } from './run';

/*
 * parse_document (design §§9–11): read the admitted text, check it with the input guardrail, make
 * one bounded model call (plus at most one schema repair), then ground and validate the result.
 *
 * Money first: before every paid call the worst case is written to the job's ledger under the
 * lease, and only a call whose bound fits what is left of the job's cap is made. The actual charge
 * replaces the bound afterwards; a call whose outcome is unknown keeps its bound. Inference is
 * planned before the guardrail is paid for, so a job never pays to check text it cannot afford to
 * parse.
 */

export type ParseDeps = {
  store: Store;
  blobs: BlobStore;
  model: ModelClient;
  guardrail: Guardrail;
  logger: Logger;
};

const GUARDRAIL_TIMEOUT_MS = 20_000;
/** Largest text artifact read back for a document (100,000 characters as JSON). */
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

type Source = {
  text: string;
  meta: SourceMeta;
  extraction: ParseDocumentResult['extraction'];
  warnings: Warning[];
};

class Stop extends Error {
  constructor(readonly outcome: StepOutcome) {
    super('stop');
    this.name = 'Stop';
  }
}

const failed = (code: JobError['code']): never => {
  throw new Stop({ kind: 'failed', code });
};

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
  const missing = document.warnings.some((warning) => warning.code === 'ocr_pages_missing');
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
  return async (context) => {
    try {
      return await run(deps, context);
    } catch (error) {
      if (error instanceof Stop) return error.outcome;
      throw error;
    }
  };
}

async function run(deps: ParseDeps, context: StepContext): Promise<StepOutcome> {
  const { job } = context;
  const ledger: Ledger = structuredClone(job.exec.checkpoints);
  const spent = () => spentMicroUsd(ledger);
  const cap = job.budgetCapMicroUsd;
  const withSpend = (outcome: StepOutcome): StepOutcome =>
    outcome.kind === 'failed' ? { ...outcome, spendMicroUsd: spent() } : outcome;
  const stop = (code: JobError['code']): never => {
    throw new Stop(withSpend({ kind: 'failed', code }));
  };
  const write = async (step: JobStage, refs: Record<string, string>) => {
    ledger[step] = refs;
    if (!(await context.checkpoint(step, refs))) {
      // The lease moved on: whatever we write next is refused, so stop here.
      throw new Stop({ kind: 'retry', step });
    }
  };

  const request = await deps.store.jobs.input(job.ownerId, job.jobId);
  if (!request || request.operation !== 'parse_document') return stop('revoked');
  let source: Source;
  try {
    source = await loadSource(deps, job.ownerId, request.input);
  } catch (error) {
    if (error instanceof Stop) throw new Stop(withSpend(error.outcome));
    throw new TransientError('extraction');
  }
  const { text } = source;
  const textBytes = Buffer.byteLength(text, 'utf8');

  // What the first inference call needs, so the guardrail is not paid for text we cannot parse.
  const firstCall = (available: number) =>
    planCall(PARSE_MODEL_ID, FIXED_REQUEST_BYTES + textBytes, OUTPUT_TOKENS, available);

  // 1. Input safeguard, once per text and policy version.
  const digest = `${sha256Hex(Buffer.from(text, 'utf8'))}@${deps.guardrail.id}:${deps.guardrail.version}`;
  const guard = { ...(ledger.safeguard ?? {}) };
  if (guard.blocked === digest) return stop('input_policy_blocked');
  if (guard.passed !== digest) {
    const bound = guardrailBound(text.length);
    if (!firstCall(cap - spent() - bound)) return stop('budget_exceeded');
    const entry = nextEntry(guard);
    guard[entry] = reserved(bound);
    await write('safeguard', guard);
    let units = 0;
    let blocked = false;
    for (const chunk of guardrailChunks(text)) {
      const result = await call('safeguard', () =>
        deps.guardrail.check(chunk, GUARDRAIL_TIMEOUT_MS),
      );
      units += result.units ?? guardrailUnits(chunk.length);
      if (result.intervened) {
        blocked = true;
        break;
      }
    }
    guard[entry] = settled(bound, guardrailCostMicroUsd(units));
    guard[blocked ? 'blocked' : 'passed'] = digest;
    await write('safeguard', guard);
    deps.logger.log(blocked ? 'warn' : 'info', {
      event: 'guardrail_checked',
      jobId: job.jobId,
      outcome: blocked ? 'blocked' : 'passed',
      count: units,
    });
    if (blocked) return stop('input_policy_blocked');
  }

  // 2. Inference, with at most one schema repair.
  const infer = { ...(ledger.inference ?? {}) };
  const messages: ModelMessage[] = [{ role: 'user', text: userMessage(text) }];
  let repairs = Number(infer.repairs ?? 0);
  for (;;) {
    const extraBytes = messages
      .slice(1)
      .reduce(
        (sum, message) =>
          sum +
          Buffer.byteLength(
            message.role === 'assistant' ? JSON.stringify(message.input) : message.text,
          ),
        0,
      );
    const plan = planCall(
      PARSE_MODEL_ID,
      FIXED_REQUEST_BYTES + textBytes + extraBytes,
      OUTPUT_TOKENS,
      cap - spent(),
    );
    if (!plan) return stop('budget_exceeded');
    const entry = nextEntry(infer);
    infer[entry] = reserved(plan.boundMicroUsd);
    await write('inference', infer);

    const response = await call('inference', () =>
      deps.model.converse({
        modelId: PARSE_MODEL_ID,
        system: SYSTEM_PROMPT,
        messages,
        tool: { name: TOOL_NAME, description: TOOL_DESCRIPTION, schema: TOOL_SCHEMA },
        maxTokens: plan.maxTokens,
        timeoutMs: MODEL_TIMEOUT_MS,
      }),
    );
    // Missing usage keeps the full bound: the call may have been charged at its worst case.
    const actual = response.usage
      ? modelCostMicroUsd(PARSE_MODEL_ID, response.usage)
      : plan.boundMicroUsd;
    infer[entry] = settled(plan.boundMicroUsd, actual);
    if (response.requestId)
      infer[`request.${entry.slice('spend.'.length)}`] = response.requestId.slice(0, 128);
    await write('inference', infer);
    deps.logger.log('info', {
      event: 'model_called',
      jobId: job.jobId,
      modelId: PARSE_MODEL_ID,
      promptVersion: PROMPT_VERSION,
      stopReason: response.stopReason,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      costMicroUsd: actual,
      requestId: response.requestId ?? undefined,
    });

    // A cut-off answer is never published as if complete.
    if (response.stopReason === 'max_tokens') return stop('output_truncated');
    if (
      response.stopReason === 'content_filtered' ||
      response.stopReason === 'guardrail_intervened' ||
      !response.toolUse
    ) {
      return stop('model_refusal');
    }
    const parsed = modelOutputSchema.safeParse(response.toolUse.input);
    if (parsed.success) {
      return publish(job, request.input, source, parsed.data, spent());
    }
    if (repairs >= 1) return stop('validation_failed');
    repairs += 1;
    infer.repairs = String(repairs);
    messages.push(
      { role: 'assistant', toolUseId: response.toolUse.id, input: response.toolUse.input },
      {
        role: 'tool_result',
        toolUseId: response.toolUse.id,
        text: repairMessage(
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.code,
          })),
        ),
      },
    );
  }

  /** Runs one provider call, mapping its failure to a retry or a terminal outcome. */
  async function call<T>(step: JobStage, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw new TransientError(step);
      if (error instanceof ProviderRejectedError || error instanceof UnpricedModelError) {
        deps.logger.log('error', { event: 'provider_rejected', jobId: job.jobId, step });
        return stop('dependency_unavailable');
      }
      throw error;
    }
  }

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
