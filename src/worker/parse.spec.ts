import { randomUUID } from 'crypto';

import { resultEnvelopeSchemas, type CreateJobRequest } from '@talvio/llm-contracts';

import { createMemoryBlobs, sha256Hex, textArtifactKey } from '../lib/blob';
import { createLogger } from '../lib/log';
import {
  createScriptedGuardrail,
  createScriptedModel,
  ProviderRejectedError,
  ProviderUnavailableError,
  type ModelResponse,
} from '../lib/model/client';
import { spentMicroUsd } from '../lib/model/budget';
import { PARSE_MODEL_ID, PROMPT_VERSION, TOOL_NAME } from '../lib/prompts/parse-document';
import type { WorkMessage } from '../lib/queue';
import { createMemoryStore, type MemoryStore } from '../lib/store/memory';
import { modelOutput, RESUME } from '../test/fixtures/parse';
import { createParseExecutor } from './parse';
import { runJob } from './run';

const OWNER = randomUUID();
const START = new Date('2026-11-10T12:00:00.000Z');

const answer = (
  input: unknown = modelOutput(),
  extra: Partial<ModelResponse> = {},
): ModelResponse => ({
  stopReason: 'tool_use',
  toolUse: { id: 'tool-1', input },
  usage: { inputTokens: 3_000, outputTokens: 1_500 },
  requestId: 'req-1',
  ...extra,
});

describe('parse_document executor', () => {
  let store: MemoryStore;
  let blobs: ReturnType<typeof createMemoryBlobs>;
  let model: ReturnType<typeof createScriptedModel>;
  let guardrail: ReturnType<typeof createScriptedGuardrail>;
  let logs: string[];
  let jobId: string;

  async function admit(input: CreateJobRequest['input']) {
    const admitted = await store.jobs.admit({
      ownerId: OWNER,
      plan: 'free',
      pipelineReleaseId: 'v1',
      idempotencyKey: `key-${randomUUID()}`,
      requestHash: randomUUID(),
      request: {
        schemaVersion: '1.0',
        clientRequestId: 'key-00000001',
        locale: 'en-US',
        operation: 'parse_document',
        input,
      } as CreateJobRequest,
      now: START,
      deadlineAt: new Date(START.getTime() + 600_000),
    });
    jobId = admitted.job.jobId;
  }

  const run = () => {
    const logger = createLogger('debug', (line) => logs.push(line));
    const message: WorkMessage = {
      v: 1,
      type: 'job.admitted',
      ownerId: OWNER,
      jobId,
      eventId: randomUUID(),
    };
    return runJob(
      {
        store,
        logger,
        executors: {
          parse_document: createParseExecutor({ store, blobs, model, guardrail, logger }),
        },
        now: () => START,
        random: () => 0,
      },
      message,
    );
  };
  const job = () => store.jobs.get(OWNER, jobId);

  beforeEach(async () => {
    store = createMemoryStore();
    blobs = createMemoryBlobs();
    model = createScriptedModel();
    guardrail = createScriptedGuardrail();
    logs = [];
    await admit({ kind: 'text', text: RESUME, extraction: null });
  });

  it('checks the input, makes one pinned call and publishes a grounded, valid result', async () => {
    model.responses.push(answer());
    guardrail.results.push({ intervened: false, units: 2 });
    expect(await run()).toBe('succeeded');

    const done = await job();
    const envelope = resultEnvelopeSchemas.parse_document.parse(done!.result);
    expect(envelope).toMatchObject({
      jobId,
      resultKind: 'complete',
      versions: { pipelineReleaseId: 'v1', promptVersion: PROMPT_VERSION, modelId: PARSE_MODEL_ID },
      result: { extraction: { method: 'plain_text', complete: true } },
    });
    expect(envelope.result.career.experience[0]?.company).toBe('Acme Payments');

    // The whole text was checked as untrusted input, and the model got exactly one forced tool.
    expect(guardrail.checked).toEqual([RESUME]);
    expect(model.requests).toHaveLength(1);
    const sent = model.requests[0]!;
    expect(sent).toMatchObject({ modelId: PARSE_MODEL_ID, tool: { name: TOOL_NAME } });
    expect(sent.messages[0]).toMatchObject({ role: 'user' });
    expect(sent.maxTokens).toBeGreaterThanOrEqual(4_096);

    // Spend is what was charged: 2 guardrail units plus the metered tokens, under the cap.
    const expected =
      300 + Math.ceil((3_000 * 330_000) / 1e6) + Math.ceil((1_500 * 2_750_000) / 1e6);
    expect(done).toMatchObject({ spendCommittedMicroUsd: expected, spendReservedMicroUsd: 0 });
    expect(spentMicroUsd(done!.exec.checkpoints)).toBe(expected);

    // Logs carry ids and numbers, never resume text.
    expect(logs.join('\n')).not.toMatch(/Beridze|Acme|ledger/);
    expect(logs.join('\n')).toContain('"stopReason":"tool_use"');
  });

  it('ends the job when the guardrail intervenes, before any model call', async () => {
    guardrail.results.push({ intervened: true, units: 2 });
    expect(await run()).toBe('failed');
    expect(await job()).toMatchObject({
      error: { code: 'input_policy_blocked' },
      spendCommittedMicroUsd: 300,
    });
    expect(model.requests).toHaveLength(0);
  });

  it('never publishes a cut-off answer, and maps refusals', async () => {
    model.responses.push(answer(modelOutput(), { stopReason: 'max_tokens' }));
    expect(await run()).toBe('failed');
    expect((await job())?.error?.code).toBe('output_truncated');

    await admit({ kind: 'text', text: RESUME, extraction: null });
    model.responses.push(answer(null, { stopReason: 'end_turn', toolUse: null }));
    expect(await run()).toBe('failed');
    expect((await job())?.error?.code).toBe('model_refusal');
  });

  it('repairs an invalid tool input once, then gives up', async () => {
    model.responses.push(answer({ person: 'nope' }), answer());
    expect(await run()).toBe('succeeded');
    const repair = model.requests[1]!;
    expect(repair.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_result']);
    // The repair note names paths and codes only.
    const note = repair.messages[2];
    expect(note && 'text' in note ? note.text : '').not.toContain('nope');

    await admit({ kind: 'text', text: RESUME, extraction: null });
    model.responses.push(answer({ person: 'nope' }), answer({ person: 'still' }));
    expect(await run()).toBe('failed');
    expect((await job())?.error?.code).toBe('validation_failed');
  });

  it('retries an unavailable provider while keeping the possibly-charged bound, and reuses the passed check', async () => {
    model.responses.push(new ProviderUnavailableError());
    expect(await run()).toBe('retrying');
    const waiting = await job();
    const bound = Number(waiting!.exec.checkpoints.inference?.['spend.1']);
    expect(bound).toBeGreaterThan(0);
    expect(spentMicroUsd(waiting!.exec.checkpoints)).toBeGreaterThanOrEqual(bound);

    model.responses.push(answer());
    store.testing.setJob(jobId, { exec: { ...waiting!.exec, availableAt: START } });
    expect(await run()).toBe('succeeded');
    expect(guardrail.checked).toHaveLength(1);
    // The unknown first call stays counted at its bound in the job's spend.
    expect((await job())!.spendCommittedMicroUsd).toBeGreaterThan(bound);
  });

  it('fails without retrying when the provider refuses the request itself', async () => {
    model.responses.push(new ProviderRejectedError());
    expect(await run()).toBe('failed');
    expect((await job())?.error?.code).toBe('dependency_unavailable');
  });

  it('refuses a call that cannot fit what is left of the cap', async () => {
    const admitted = await job();
    store.testing.setJob(jobId, {
      budgetCapMicroUsd: 5_000,
      spendReservedMicroUsd: 5_000,
      exec: admitted!.exec,
    });
    expect(await run()).toBe('failed');
    expect((await job())?.error?.code).toBe('budget_exceeded');
    expect(guardrail.checked).toHaveLength(0);
    expect(model.requests).toHaveLength(0);
  });

  it('reads an uploaded document from its pinned artifact, and stops once it is deleted', async () => {
    const created = await store.documents.create(
      OWNER,
      {
        schemaVersion: '1.0',
        fileName: 'cv',
        contentType: 'text/plain' as never,
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
      },
      `pending/${OWNER}/x`,
      START,
    );
    const key = textArtifactKey(OWNER, created.documentId);
    const versionId = await blobs.write(
      'artifacts',
      key,
      Buffer.from(JSON.stringify({ v: 1, text: RESUME })),
      'application/json',
    );
    await store.documents.complete(OWNER, created.documentId, { versionId: 'v0' }, START);
    await store.documents.finish(
      OWNER,
      created.documentId,
      {
        kind: 'ready',
        pageCount: null,
        ocrPages: [],
        warnings: [{ code: 'docx_images_not_read', message: '1 image was not read.' }],
        artifact: {
          key,
          versionId,
          sha256: sha256Hex(Buffer.from(RESUME)),
          chars: RESUME.length,
          bytes: Buffer.byteLength(RESUME),
          extractorVersion: 'docx-1',
          method: 'docx',
        },
      },
      START,
    );

    await admit({ kind: 'document', documentId: created.documentId });
    model.responses.push(answer());
    expect(await run()).toBe('succeeded');
    const envelope = resultEnvelopeSchemas.parse_document.parse((await job())!.result);
    expect(envelope.result.extraction.method).toBe('docx');
    expect(envelope.warnings).toContainEqual(
      expect.objectContaining({ code: 'docx_images_not_read' }),
    );
    expect(envelope.result.facts[0]?.evidence[0]?.clientSupplied).toBe(false);

    await admit({ kind: 'document', documentId: created.documentId });
    await store.documents.delete(OWNER, created.documentId);
    expect(await run()).toBe('failed');
    expect((await job())?.error?.code).toBe('revoked');
  });
});
