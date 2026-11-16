import {
  resultEnvelopeSchemas,
  type CareerDocument,
  type Operation,
  type OperationResult,
} from '@talvio/llm-contracts';

import { createMemoryBlobs } from '../lib/blob';
import { contentHash } from '../lib/hash';
import { createLogger, type Logger } from '../lib/log';
import { spentMicroUsd } from '../lib/model/budget';
import type { Guardrail, ModelClient } from '../lib/model/client';
import { createMemoryStore, type MemoryStore } from '../lib/store/memory';
import { createAnalyzeExecutor } from '../worker/analyze';
import { createImproveExecutor } from '../worker/improve';
import { createParseExecutor } from '../worker/parse';
import { createQuestionsExecutor } from '../worker/questions';
import { runJob, type Executor } from '../worker/run';
import { createTailorExecutor } from '../worker/tailor';
import {
  personaById,
  personaSnapshot,
  type DocumentFixture,
  type JobFixture,
  type SourceType,
} from './fixtures';
import { evaluateGates, type GateResult } from './gates';
import type { Persona } from './personas';
import {
  addCounts,
  checkProposal,
  emptyCounts,
  injectionHits,
  percentile,
  scoreExtraction,
  type FieldCounts,
  type Finding,
} from './score';

/*
 * Runs the evaluation set through the real executors (MDI-223, design §14) with whichever model
 * and guardrail it is given: the real providers for a release measurement (eval.live.spec.ts), a scripted
 * model in CI (eval.spec.ts). Each job runs on its own in-memory store, exactly as a worker would
 * run it, and is scored on what it published.
 *
 * The report is content-free: fixture ids, counts, money, tokens and timings. Question text is
 * returned separately, for people to rate, and is synthetic like the rest of the set.
 */

const OWNER = '00000000-0000-4000-8000-00000000e7a1';
const DEADLINE_MS = 3_600_000;
/** A retry waits for its backoff; the harness moves its clock instead of sleeping. */
const RETRY_SKEW_MS = 300_000;
const MAX_RUNS = 4;

export type JobOutcome = {
  fixtureId: string;
  operation: Operation;
  sourceType: SourceType | null;
  status: string;
  errorCode: string | null;
  /** Published results only: did the envelope pass the contract schema. */
  schemaValid: boolean | null;
  durationMs: number;
  costMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
};

export type OperationStats = {
  runs: number;
  succeeded: number;
  /** Succeeded, or refused by the input guardrail on a fixture that carries an injection. */
  completed: number;
  maxMicroUsd: number;
  p95MicroUsd: number;
  p95Ms: number;
  inputTokens: number;
  outputTokens: number;
};

export type Report = {
  set: {
    documents: number;
    jobDescriptions: number;
    bySourceType: Record<string, number>;
    byTrait: Record<string, number>;
  };
  extraction: {
    all: FieldCounts;
    bySourceType: Record<string, FieldCounts>;
    byTrait: Record<string, FieldCounts>;
  };
  injectionHits: number;
  proposals: {
    checked: number;
    lost: number;
    fabrications: number;
    findings: (Finding & { fixtureId: string; class: 'fabrication' | 'preservation' })[];
  };
  schema: { succeeded: number; valid: number };
  operations: Record<string, OperationStats>;
  questions: { asked: number; rated: number; useful: number };
  jobs: JobOutcome[];
  gates: GateResult[];
};

export type QuestionSample = { key: string; fixtureId: string; prompt: string; reason: string };

export type EvalOptions = {
  model: ModelClient;
  guardrail: Guardrail;
  documents: DocumentFixture[];
  jobs: JobFixture[];
  /** Personas whose profile is improved without a job description. */
  improve: Persona[];
  /** Usefulness ratings keyed by QuestionSample.key, from people (design §14). */
  ratings?: Record<string, boolean>;
  logger?: Logger;
};

/** Counts tokens and calls per job, around any model client. */
function meter(inner: ModelClient) {
  let usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
  const client: ModelClient = {
    async converse(request) {
      usage.modelCalls += 1;
      const response = await inner.converse(request);
      usage.inputTokens += response.usage?.inputTokens ?? 0;
      usage.outputTokens += response.usage?.outputTokens ?? 0;
      return response;
    },
  };
  return {
    client,
    take() {
      const taken = usage;
      usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
      return taken;
    },
  };
}

type Runner = {
  store: MemoryStore;
  executors: Partial<Record<Operation, Executor>>;
  metered: ReturnType<typeof meter>;
  logger: Logger;
};

function runner(options: EvalOptions, logger: Logger): Runner {
  const store = createMemoryStore();
  const metered = meter(options.model);
  const deps = { store, model: metered.client, guardrail: options.guardrail, logger };
  return {
    store,
    metered,
    logger,
    executors: {
      parse_document: createParseExecutor({ ...deps, blobs: createMemoryBlobs() }),
      analyze_resume: createAnalyzeExecutor(deps),
      generate_questions: createQuestionsExecutor(deps),
      improve_profile: createImproveExecutor(deps, 'improve_profile'),
      improve_resume: createImproveExecutor(deps, 'improve_resume'),
      tailor_resume: createTailorExecutor(deps),
    },
  };
}

type Admission = Parameters<MemoryStore['jobs']['admit']>[0];

/** Admits one job, runs it to an end state and returns what it published. */
async function execute(
  run: Runner,
  fixtureId: string,
  sourceType: SourceType | null,
  request: Admission['request'],
  extra: Partial<Admission> = {},
): Promise<{ outcome: JobOutcome; result: unknown; jobId: string }> {
  const started = Date.now();
  const key = `eval-${fixtureId}-${request.operation}`;
  const { job } = await run.store.jobs.admit({
    ownerId: OWNER,
    plan: 'free',
    pipelineReleaseId: 'eval',
    idempotencyKey: key,
    requestHash: key,
    request,
    now: new Date(started),
    deadlineAt: new Date(started + DEADLINE_MS),
    ...extra,
  });
  let skew = 0;
  for (let attempt = 0; attempt < MAX_RUNS; attempt += 1) {
    const result = await runJob(
      {
        store: run.store,
        logger: run.logger,
        executors: run.executors,
        now: () => new Date(Date.now() + skew),
      },
      {
        v: 1,
        type: 'job.admitted',
        ownerId: OWNER,
        jobId: job.jobId,
        eventId: `${job.jobId}:${attempt}`,
      },
    );
    if (result !== 'retrying') break;
    skew += RETRY_SKEW_MS;
  }
  const done = (await run.store.jobs.get(OWNER, job.jobId))!;
  const usage = run.metered.take();
  const published = done.status === 'succeeded' ? done.result : null;
  const schemaValid =
    published === null
      ? null
      : resultEnvelopeSchemas[request.operation as Operation].safeParse(published).success;
  return {
    jobId: job.jobId,
    result: published,
    outcome: {
      fixtureId,
      operation: request.operation as Operation,
      sourceType,
      status: done.status,
      errorCode: done.error?.code ?? null,
      schemaValid,
      durationMs: Date.now() - started,
      costMicroUsd: spentMicroUsd(done.exec.checkpoints),
      ...usage,
    },
  };
}

const envelopeResult = <T>(published: unknown): T | null =>
  published ? ((published as { result: T }).result ?? null) : null;

async function session(
  run: Runner,
  persona: Persona,
  job: JobFixture | null,
): Promise<{ sessionId: string; contextRevisionId: string; source: CareerDocument }> {
  const snapshot = personaSnapshot(persona);
  const sourceHash = contentHash(snapshot);
  const jobDescriptionHash = job ? contentHash(job.jobDescription) : null;
  const { session: created } = await run.store.sessions.create({
    ownerId: OWNER,
    clientRequestId: `eval-${job?.id ?? persona.id}`,
    requestHash: job?.id ?? persona.id,
    purpose: job ? 'tailor' : 'improve',
    context: {
      source: snapshot,
      jobDescription: job?.jobDescription ?? null,
      sourceHash,
      jobDescriptionHash,
      contextHash: contentHash({ sourceHash, jobDescriptionHash, answerRevisionId: null }),
    },
    now: new Date(),
  });
  return {
    sessionId: created.sessionId,
    contextRevisionId: created.latestContext.contextRevisionId,
    source: snapshot.document,
  };
}

const sessionRequest = (
  operation: Operation,
  ids: { sessionId: string; contextRevisionId: string },
  fixtureId: string,
  input: unknown,
) =>
  ({
    schemaVersion: '1.0',
    clientRequestId: `eval-${fixtureId}-${operation}`.slice(0, 64),
    locale: 'en-US',
    operation,
    sessionId: ids.sessionId,
    contextRevisionId: ids.contextRevisionId,
    parentJobId: null,
    input,
  }) as never;

export async function evaluate(
  options: EvalOptions,
): Promise<{ report: Report; questions: QuestionSample[] }> {
  const logger = options.logger ?? createLogger('error', () => undefined);
  const outcomes: JobOutcome[] = [];
  const all = emptyCounts();
  const bySourceType: Record<string, FieldCounts> = {};
  const byTrait: Record<string, FieldCounts> = {};
  let hits = 0;

  for (const fixture of options.documents) {
    const run = runner(options, logger);
    const { outcome, result } = await execute(run, fixture.id, fixture.sourceType, {
      schemaVersion: '1.0',
      clientRequestId: `eval-${fixture.id}`,
      locale: 'en-US',
      operation: 'parse_document',
      input: {
        kind: 'text',
        text: fixture.text,
        extraction:
          fixture.sourceType === 'pdf_text'
            ? {
                extractor: 'pdfjs-dist',
                extractorVersion: '4.10.38',
                pageCount: 1,
                pages: [{ page: 1, start: 0, end: fixture.text.length, coverage: 'text' }],
              }
            : null,
      },
    } as never);
    outcomes.push(outcome);
    const parsed = envelopeResult<OperationResult<'parse_document'>>(result);
    // A job that published nothing scores as having found nothing.
    const counts = parsed
      ? scoreExtraction(fixture.truth, parsed.career)
      : scoreExtraction(fixture.truth, EMPTY_CAREER);
    addCounts(all, counts);
    addCounts((bySourceType[fixture.sourceType] ??= emptyCounts()), counts);
    for (const trait of fixture.traits) addCounts((byTrait[trait] ??= emptyCounts()), counts);
    if (parsed) hits += injectionHits(parsed.career, fixture.forbidden);
  }

  const findings: Report['proposals']['findings'] = [];
  let checked = 0;
  let lost = 0;
  const questions: QuestionSample[] = [];

  const scoreProposal = (
    fixtureId: string,
    source: CareerDocument,
    published: unknown,
    forbidden: string[],
  ) => {
    const body = envelopeResult<{ proposal: OperationResult<'improve_profile'>['proposal'] }>(
      published,
    );
    if (!body) return;
    const check = checkProposal({ source, proposal: body.proposal, forbidden });
    checked += check.preservation.checked;
    lost += check.preservation.lost.length;
    findings.push(
      ...check.fabrications.map((f) => ({ ...f, fixtureId, class: 'fabrication' as const })),
      ...check.preservation.lost.map((f) => ({ ...f, fixtureId, class: 'preservation' as const })),
    );
  };

  for (const job of options.jobs) {
    const run = runner(options, logger);
    const ids = await session(run, personaById(job.personaId), job);
    const analysis = await execute(
      run,
      job.id,
      null,
      sessionRequest('analyze_resume', ids, job.id, { sections: [] }),
    );
    outcomes.push(analysis.outcome);
    const asked = await execute(
      run,
      job.id,
      null,
      sessionRequest('generate_questions', ids, job.id, {
        analysisJobId: analysis.result ? analysis.jobId : null,
        round: 1,
        maxQuestions: 5,
      }),
      { questionRound: { round: 1, slots: 5, replaces: null } } as Partial<Admission>,
    );
    outcomes.push(asked.outcome);
    const set = envelopeResult<OperationResult<'generate_questions'>>(asked.result);
    for (const question of set?.questions ?? []) {
      questions.push({
        // Bound to the question's text, so a rating never carries over to a different question.
        key: `${job.id}/${question.topicKey}/${contentHash({ prompt: question.prompt, reason: question.reason }).slice(0, 12)}`,
        fixtureId: job.id,
        prompt: question.prompt,
        reason: question.reason,
      });
    }
    const tailored = await execute(
      run,
      job.id,
      null,
      sessionRequest('tailor_resume', ids, job.id, { resumeName: `Eval ${job.id}` }),
    );
    outcomes.push(tailored.outcome);
    scoreProposal(job.id, ids.source, tailored.result, job.forbidden);
  }

  for (const persona of options.improve) {
    const run = runner(options, logger);
    const ids = await session(run, persona, null);
    const improved = await execute(
      run,
      `${persona.id}-improve`,
      null,
      sessionRequest('improve_profile', ids, persona.id, { sections: [], targetRole: null }),
    );
    outcomes.push(improved.outcome);
    scoreProposal(`${persona.id}-improve`, ids.source, improved.result, []);
  }

  // A blocked injection is the guardrail working; any other failure counts against completion.
  const injected = new Set([
    ...options.documents.filter((d) => d.traits.includes('injection')).map((d) => d.id),
    ...options.jobs.filter((j) => j.traits.includes('injection')).map((j) => j.id),
  ]);
  const operations: Record<string, OperationStats> = {};
  for (const outcome of outcomes) {
    const stats = (operations[outcome.operation] ??= {
      runs: 0,
      succeeded: 0,
      completed: 0,
      maxMicroUsd: 0,
      p95MicroUsd: 0,
      p95Ms: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    stats.runs += 1;
    if (outcome.status === 'succeeded') stats.succeeded += 1;
    if (
      outcome.status === 'succeeded' ||
      (injected.has(outcome.fixtureId) && outcome.errorCode === 'input_policy_blocked')
    ) {
      stats.completed += 1;
    }
    stats.maxMicroUsd = Math.max(stats.maxMicroUsd, outcome.costMicroUsd);
    stats.inputTokens += outcome.inputTokens;
    stats.outputTokens += outcome.outputTokens;
  }
  for (const [operation, stats] of Object.entries(operations)) {
    const mine = outcomes.filter((o) => o.operation === operation);
    stats.p95MicroUsd = percentile(
      mine.map((o) => o.costMicroUsd),
      95,
    );
    stats.p95Ms = percentile(
      mine.map((o) => o.durationMs),
      95,
    );
  }

  const ratings = options.ratings ?? {};
  const rated = questions.filter((q) => q.key in ratings);
  const succeeded = outcomes.filter((o) => o.schemaValid !== null);
  const count = (values: string[]) =>
    values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});

  const report: Omit<Report, 'gates'> = {
    set: {
      documents: options.documents.length,
      jobDescriptions: options.jobs.length,
      bySourceType: count(options.documents.map((d) => d.sourceType)),
      byTrait: count(options.documents.flatMap((d) => d.traits)),
    },
    extraction: { all, bySourceType, byTrait },
    injectionHits: hits,
    proposals: {
      checked,
      lost,
      fabrications: findings.filter((f) => f.class === 'fabrication').length,
      findings,
    },
    schema: { succeeded: succeeded.length, valid: succeeded.filter((o) => o.schemaValid).length },
    operations,
    questions: {
      asked: questions.length,
      rated: rated.length,
      useful: rated.filter((q) => ratings[q.key]).length,
    },
    jobs: outcomes,
  };
  return { report: { ...report, gates: evaluateGates(report) }, questions };
}

const EMPTY_CAREER: CareerDocument = {
  person: { firstName: null, lastName: null, role: null, tagline: null, seniority: null },
  contacts: { email: null, phone: null, url: null },
  location: { city: null, country: null },
  experience: [],
  education: [],
  projects: [],
  recommendations: [],
  skills: [],
  tools: [],
  links: [],
  languages: [],
};
