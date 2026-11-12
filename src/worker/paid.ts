import type { JobError } from '@talvio/llm-contracts';

import { sha256Hex } from '../lib/blob';
import type { Logger } from '../lib/log';
import {
  guardrailBound,
  guardrailChunks,
  nextEntry,
  planCall,
  reserved,
  settled,
  spentMicroUsd,
  type CallPlan,
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
import { fixedBytes, type PromptPack } from '../lib/model/pack';
import type { JobStage } from '../lib/store';
import { TransientError, type StepContext, type StepOutcome } from './run';

/*
 * The paid part of every model operation (design §§9–11): the input safeguard, then one bounded
 * model call with at most one schema repair.
 *
 * Money first: before every paid call the worst case is written to the job's ledger under the
 * lease, and only a call whose bound fits what is left of the job's cap is made. The actual charge
 * replaces the bound afterwards; a call whose outcome is unknown keeps its bound. Inference is
 * planned before the guardrail is paid for, so a job never pays to check text it cannot afford to
 * send to the model.
 */

export type ModelDeps = { model: ModelClient; guardrail: Guardrail; logger: Logger };

/** Ends the executor with `outcome`; thrown so helpers can stop the job from anywhere. */
export class Stop extends Error {
  constructor(readonly outcome: StepOutcome) {
    super('stop');
    this.name = 'Stop';
  }
}

const GUARDRAIL_TIMEOUT_MS = 20_000;

export type PaidJob = ReturnType<typeof paidJob>;

export function paidJob(deps: ModelDeps, context: StepContext) {
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

  const planFor = (pack: PromptPack<unknown>, userText: string, available: number) =>
    planCall(
      pack.modelId,
      fixedBytes(pack) + Buffer.byteLength(userText),
      pack.outputTokens,
      available,
    );

  /**
   * Checks the untrusted text once per text and guardrail version; a retry reuses a passed check.
   * `affordable` says whether the call that follows still fits once the check is paid for.
   */
  async function guard(text: string, affordable: (available: number) => CallPlan | null) {
    const digest = `${sha256Hex(Buffer.from(text, 'utf8'))}@${deps.guardrail.id}:${deps.guardrail.version}`;
    const refs = { ...(ledger.safeguard ?? {}) };
    if (refs.blocked === digest) return stop('input_policy_blocked');
    if (refs.passed === digest) return;
    const bound = guardrailBound(text.length);
    if (!affordable(cap - spent() - bound)) return stop('budget_exceeded');
    const entry = nextEntry(refs);
    refs[entry] = reserved(bound);
    await write('safeguard', refs);
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
    refs[entry] = settled(bound, guardrailCostMicroUsd(units));
    refs[blocked ? 'blocked' : 'passed'] = digest;
    await write('safeguard', refs);
    deps.logger.log(blocked ? 'warn' : 'info', {
      event: 'guardrail_checked',
      jobId: job.jobId,
      outcome: blocked ? 'blocked' : 'passed',
      count: units,
    });
    if (blocked) stop('input_policy_blocked');
  }

  /**
   * One forced-tool call plus at most one repair; returns output that passed the pack's schema.
   * A job with two calls gives each its own step, so each keeps its own entries and repair.
   */
  async function infer<T>(
    pack: PromptPack<T>,
    userText: string,
    step: JobStage = 'inference',
  ): Promise<T> {
    const refs = { ...(ledger[step] ?? {}) };
    const messages: ModelMessage[] = [{ role: 'user', text: userText }];
    let repairs = Number(refs.repairs ?? 0);
    for (;;) {
      const extra = messages
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
        pack.modelId,
        fixedBytes(pack) + Buffer.byteLength(userText) + extra,
        pack.outputTokens,
        cap - spent(),
      );
      if (!plan) return stop('budget_exceeded');
      const entry = nextEntry(refs);
      refs[entry] = reserved(plan.boundMicroUsd);
      await write(step, refs);

      const response = await call(step, () =>
        deps.model.converse({
          modelId: pack.modelId,
          system: pack.system,
          messages,
          tool: { name: pack.toolName, description: pack.toolDescription, schema: pack.toolSchema },
          maxTokens: plan.maxTokens,
          timeoutMs: pack.timeoutMs,
        }),
      );
      // Missing usage keeps the full bound: the call may have been charged at its worst case.
      const actual = response.usage
        ? modelCostMicroUsd(pack.modelId, response.usage)
        : plan.boundMicroUsd;
      refs[entry] = settled(plan.boundMicroUsd, actual);
      if (response.requestId)
        refs[`request.${entry.slice('spend.'.length)}`] = response.requestId.slice(0, 128);
      await write(step, refs);
      deps.logger.log('info', {
        event: 'model_called',
        jobId: job.jobId,
        modelId: pack.modelId,
        promptVersion: pack.promptVersion,
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
      const parsed = pack.output.safeParse(response.toolUse.input);
      if (parsed.success) return parsed.data;
      if (repairs >= 1) return stop('validation_failed');
      repairs += 1;
      refs.repairs = String(repairs);
      messages.push(
        { role: 'assistant', toolUseId: response.toolUse.id, input: response.toolUse.input },
        {
          role: 'tool_result',
          toolUseId: response.toolUse.id,
          text: pack.repairMessage(
            parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.code,
            })),
          ),
        },
      );
    }
  }

  return { ledger, spent, stop, write, call, guard, infer, planFor, withSpend };
}

/** Runs an executor body, turning a `Stop` into its outcome. */
export async function stopping(body: () => Promise<StepOutcome>): Promise<StepOutcome> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof Stop) return error.outcome;
    throw error;
  }
}
