import {
  SCHEMA_VERSION,
  resultEnvelopeSchemas,
  type Operation,
  type Warning,
} from '@talvio/llm-contracts';

import { contentHash } from '../lib/hash';
import type { Logger } from '../lib/log';
import type { PromptPack } from '../lib/model/pack';
import { prepareSession, type PreparedSession, type SessionRequest } from '../lib/session-input';
import type { JobRecord, SessionContext, Store } from '../lib/store';
import type { PaidJob } from './paid';
import type { StepOutcome } from './run';

/*
 * The parts every session operation shares: loading the job's context revision (owner-scoped; a
 * deleted or closed session revokes the job) and publishing a checked result envelope bound to
 * that revision.
 */

export type Loaded<O extends Operation> = {
  request: Extract<SessionRequest, { operation: O }>;
  context: SessionContext;
  prepared: PreparedSession;
};

export async function loadSessionJob<O extends Operation>(
  store: Store,
  job: JobRecord,
  operation: O,
  paid: PaidJob,
): Promise<Loaded<O>> {
  const request = await store.jobs.input(job.ownerId, job.jobId);
  if (!request || request.operation !== operation || !('sessionId' in request)) {
    return paid.stop('revoked');
  }
  const session = await store.sessions.get(job.ownerId, request.sessionId);
  const context = await store.sessions.context(
    job.ownerId,
    request.sessionId,
    request.contextRevisionId,
  );
  if (!session || session.status !== 'open' || !context) return paid.stop('revoked');
  return {
    request: request as Extract<SessionRequest, { operation: O }>,
    context,
    prepared: prepareSession(context),
  };
}

export function publishSession<O extends Operation>(
  deps: { logger: Logger },
  job: JobRecord,
  operation: O,
  loaded: Loaded<O>,
  pack: PromptPack<unknown>,
  outcome: { complete: boolean; warnings: Warning[]; result: unknown },
  spendMicroUsd: number,
): StepOutcome {
  const { context, request } = loaded;
  const envelope = {
    jobId: job.jobId,
    schemaVersion: SCHEMA_VERSION,
    operation,
    inputHash: contentHash(request.input),
    contextRevisionId: context.revision.contextRevisionId,
    contextHash: context.revision.contextHash,
    sourceRevision: context.source.source.revision,
    versions: {
      pipelineReleaseId: job.exec.pipelineReleaseId,
      promptVersion: pack.promptVersion,
      modelId: pack.modelId,
    },
    resultKind: outcome.complete ? ('complete' as const) : ('partial' as const),
    warnings: outcome.warnings.slice(0, 100),
    result: outcome.result,
  };
  const checked = resultEnvelopeSchemas[operation].safeParse(envelope);
  if (!checked.success) {
    deps.logger.log('error', {
      event: 'result_invalid',
      jobId: job.jobId,
      count: checked.error.issues.length,
    });
    return { kind: 'failed', code: 'validation_failed', spendMicroUsd };
  }
  return { kind: 'succeeded', result: checked.data, spendMicroUsd };
}
