import { randomUUID } from 'crypto';

import { resultEnvelopeSchemas, type CreateJobRequest } from '@talvio/llm-contracts';

import { careerView } from '../lib/career/view';
import { contentHash } from '../lib/hash';
import { createLogger } from '../lib/log';
import {
  createScriptedGuardrail,
  createScriptedModel,
  type ModelResponse,
} from '../lib/model/client';
import { ANALYZE_PACK } from '../lib/prompts/analyze-resume';
import { IMPROVE_PACK } from '../lib/prompts/improve';
import { QUESTIONS_PACK, type QuestionsOutput } from '../lib/prompts/generate-questions';
import type { WorkMessage } from '../lib/queue';
import type { AdmitJobInput } from '../lib/store';
import { createMemoryStore, type MemoryStore } from '../lib/store/memory';
import { JOB, TAILOR_SOURCE, analysisOutput, handle } from '../test/fixtures/session';
import { createAnalyzeExecutor } from './analyze';
import { createImproveExecutor } from './improve';
import { createQuestionsExecutor } from './questions';
import { runJob } from './run';

const OWNER = randomUUID();
const START = new Date('2026-11-11T12:00:00.000Z');
const view = careerView(TAILOR_SOURCE.document);

const reply = (input: unknown): ModelResponse => ({
  stopReason: 'tool_use',
  toolUse: { id: 'tool-1', input },
  usage: { inputTokens: 2_000, outputTokens: 800 },
  requestId: 'req-1',
});

const question = (topicKey: string, patch: Partial<QuestionsOutput['questions'][number]> = {}) => ({
  topicKey,
  prompt: `Tell us more about ${topicKey.replace(/[.-]/g, ' ')}.`,
  guidance: 'Describe what you did yourself.',
  reason: 'The job asks for it.',
  targetSection: 'experience' as const,
  targetEntityId: null,
  findingId: null,
  requirementIds: [],
  ...patch,
});

describe('session operations', () => {
  let store: MemoryStore;
  let model: ReturnType<typeof createScriptedModel>;
  let guardrail: ReturnType<typeof createScriptedGuardrail>;
  let logs: string[];
  let sessionId: string;
  let contextRevisionId: string;

  beforeEach(async () => {
    store = createMemoryStore();
    model = createScriptedModel();
    guardrail = createScriptedGuardrail();
    logs = [];
    const sourceHash = contentHash(TAILOR_SOURCE);
    const jobDescriptionHash = contentHash(JOB);
    const { session } = await store.sessions.create({
      ownerId: OWNER,
      clientRequestId: 'session-00000001',
      requestHash: 'h',
      purpose: 'tailor',
      context: {
        source: TAILOR_SOURCE,
        jobDescription: JOB,
        sourceHash,
        jobDescriptionHash,
        contextHash: contentHash({ sourceHash, jobDescriptionHash, answerRevisionId: null }),
      },
      now: START,
    });
    sessionId = session.sessionId;
    contextRevisionId = session.latestContext.contextRevisionId;
  });

  async function admit(
    operation: 'analyze_resume' | 'generate_questions' | 'improve_profile' | 'improve_resume',
    input: Record<string, unknown>,
    questionRound?: AdmitJobInput['questionRound'],
  ) {
    const key = `key-${randomUUID()}`;
    const { job } = await store.jobs.admit({
      ownerId: OWNER,
      plan: 'free',
      pipelineReleaseId: 'v1',
      idempotencyKey: key,
      requestHash: key,
      request: {
        schemaVersion: '1.0',
        clientRequestId: key,
        locale: 'en-US',
        operation,
        sessionId,
        contextRevisionId,
        parentJobId: null,
        input,
      } as unknown as CreateJobRequest,
      now: START,
      deadlineAt: new Date(START.getTime() + 600_000),
      ...(questionRound ? { questionRound } : {}),
    });
    return job.jobId;
  }

  const run = (jobId: string) => {
    const logger = createLogger('debug', (line) => logs.push(line));
    const deps = { store, model, guardrail, logger };
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
          analyze_resume: createAnalyzeExecutor(deps),
          generate_questions: createQuestionsExecutor(deps),
          improve_profile: createImproveExecutor(deps, 'improve_profile'),
          improve_resume: createImproveExecutor(deps, 'improve_resume'),
        },
        now: () => START,
        random: () => 0,
      },
      message,
    );
  };
  const job = (jobId: string) => store.jobs.get(OWNER, jobId);

  describe('analyze_resume', () => {
    it('guards the source and job description, makes one call and publishes a grounded analysis', async () => {
      const jobId = await admit('analyze_resume', { sections: [] });
      model.responses.push(reply(analysisOutput(view)));
      expect(await run(jobId)).toBe('succeeded');

      const envelope = resultEnvelopeSchemas.analyze_resume.parse((await job(jobId))!.result);
      expect(envelope).toMatchObject({
        resultKind: 'complete',
        contextRevisionId,
        sourceRevision: TAILOR_SOURCE.source.revision,
        versions: { promptVersion: ANALYZE_PACK.promptVersion, modelId: ANALYZE_PACK.modelId },
      });
      expect(envelope.result.requirements).toHaveLength(4);

      // Untrusted content was checked, and contacts and names never reached the guardrail or model.
      expect(guardrail.checked.join('\n')).toContain(JOB.text);
      const sent = JSON.stringify(model.requests[0]);
      expect(sent).not.toMatch(/nino@example\.com|Beridze|github\.com/);
      expect(model.requests[0]).toMatchObject({ tool: { name: ANALYZE_PACK.toolName } });
      expect(logs.join('\n')).not.toMatch(/Acme|Initech|PostgreSQL/);
      expect((await job(jobId))?.spendCommittedMicroUsd).toBeGreaterThan(0);
    });

    it('stops when the guardrail blocks the input', async () => {
      const jobId = await admit('analyze_resume', { sections: [] });
      guardrail.results.push({ intervened: true, units: 1 });
      expect(await run(jobId)).toBe('failed');
      expect((await job(jobId))?.error?.code).toBe('input_policy_blocked');
      expect(model.requests).toHaveLength(0);
    });

    it('is revoked when its session is deleted', async () => {
      const jobId = await admit('analyze_resume', { sections: [] });
      await store.sessions.delete(OWNER, sessionId);
      expect(await run(jobId)).toBe('failed');
      expect((await job(jobId))?.error?.code).toBe('revoked');
      expect(guardrail.checked).toHaveLength(0);
    });
  });

  describe('generate_questions', () => {
    const ask = (
      input: Partial<{ analysisJobId: string | null; round: number; maxQuestions: number }> = {},
      slots = 5,
    ) =>
      admit(
        'generate_questions',
        { analysisJobId: null, round: 1, maxQuestions: 5, ...input },
        { round: input.round ?? 1, slots, replaces: null },
      );

    it('issues the set, commits the round and the count, and publishes it', async () => {
      const jobId = await ask();
      model.responses.push(
        reply({ questions: [question('experience.team-size'), question('skills.go-years')] }),
      );
      expect(await run(jobId)).toBe('succeeded');
      const envelope = resultEnvelopeSchemas.generate_questions.parse((await job(jobId))!.result);
      expect(envelope.result.questions.map((q) => q.id)).toEqual(['r1-q1', 'r1-q2']);
      expect(model.requests[0]).toMatchObject({ tool: { name: QUESTIONS_PACK.toolName } });

      const set = await store.sessions.getQuestionSet(
        OWNER,
        sessionId,
        envelope.result.questionSetId,
      );
      expect(set).toMatchObject({ jobId, round: 1, questions: envelope.result.questions });
      expect(await store.sessions.get(OWNER, sessionId)).toMatchObject({
        questionRoundsUsed: 1,
        questionsIssued: 2,
      });
    });

    it('publishes the set it already issued instead of asking again', async () => {
      const jobId = await ask();
      model.responses.push(reply({ questions: [question('experience.team-size')] }));
      expect(await run(jobId)).toBe('succeeded');
      const first = resultEnvelopeSchemas.generate_questions.parse((await job(jobId))!.result);
      // As if the result write had been lost: the job runs again with its checkpoints.
      store.testing.setJob(jobId, { status: 'queued', result: null });
      expect(await run(jobId)).toBe('succeeded');
      const again = resultEnvelopeSchemas.generate_questions.parse((await job(jobId))!.result);
      expect(again.result).toEqual(first.result);
      expect(model.requests).toHaveLength(1);
      expect((await store.sessions.get(OWNER, sessionId))?.questionsIssued).toBe(1);
    });

    it('issues an empty set without a model call when no slot is left', async () => {
      const jobId = await ask({ maxQuestions: 0 }, 0);
      expect(await run(jobId)).toBe('succeeded');
      const envelope = resultEnvelopeSchemas.generate_questions.parse((await job(jobId))!.result);
      expect(envelope.result.questions).toEqual([]);
      expect(model.requests).toHaveLength(0);
      expect(guardrail.checked).toHaveLength(0);
    });

    it('builds on a compatible analysis and skips topics already asked', async () => {
      const analysisJobId = await admit('analyze_resume', { sections: [] });
      model.responses.push(reply(analysisOutput(view)));
      expect(await run(analysisJobId)).toBe('succeeded');
      store.testing.addQuestionSet({
        sessionId,
        round: 0,
        questions: [
          {
            ...question('experience.on-call'),
            id: 'r0-q1',
            targetEntityId: null,
            requirementIds: [],
          } as never,
        ],
        sourceHash: contentHash(TAILOR_SOURCE),
        jobDescriptionHash: contentHash(JOB),
      });

      const jobId = await ask({ analysisJobId });
      model.responses.push(
        reply({
          questions: [
            question('experience.on-call'),
            question('skills.go-years', { requirementIds: ['req-1'], findingId: 'finding-2' }),
          ],
        }),
      );
      expect(await run(jobId)).toBe('succeeded');
      const envelope = resultEnvelopeSchemas.generate_questions.parse((await job(jobId))!.result);
      expect(envelope.result.questions).toEqual([
        expect.objectContaining({ topicKey: 'skills.go-years', requirementIds: ['req-1'] }),
      ]);
      expect(envelope.warnings.map((w) => w.code)).toEqual(['questions_dropped']);
      // The analysis and the asked topic were in the request.
      const sent = model.requests.at(-1)!.messages[0]!;
      expect(sent.role === 'user' && sent.text).toContain('finding-2');
      expect(sent.role === 'user' && sent.text).toContain('experience.on-call (unanswered)');
    });

    it('does not issue when another job took the round over', async () => {
      const jobId = await ask();
      const session = await store.sessions.get(OWNER, sessionId);
      session!.rounds[1] = { jobId: randomUUID(), slots: 5 };
      expect(await run(jobId)).toBe('failed');
      expect((await job(jobId))?.error?.code).toBe('revoked');
      expect(model.requests).toHaveLength(0);
    });
  });

  describe('improve_profile / improve_resume', () => {
    const ACME = '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f51';
    const lines = careerView(TAILOR_SOURCE.document, { descriptionLines: true });

    it('guards the source and target role, makes one call and publishes a reviewable proposal', async () => {
      const jobId = await admit('improve_profile', {
        sections: ['experience'],
        targetRole: 'Staff Engineer',
      });
      model.responses.push(
        reply({
          changes: [
            {
              entityId: ACME,
              field: 'achievements',
              value: null,
              lines: [
                {
                  keep: null,
                  text: 'Reduced checkout latency by 40%',
                  from: [handle(lines, ACME, 'achievements.0')],
                  style: null,
                },
              ],
              reason: 'Stronger verb.',
            },
          ],
          additions: [],
          summary: 'Sharper Acme achievement.',
        }),
      );
      expect(await run(jobId)).toBe('succeeded');

      const envelope = resultEnvelopeSchemas.improve_profile.parse((await job(jobId))!.result);
      expect(envelope).toMatchObject({
        resultKind: 'complete',
        contextRevisionId,
        versions: { promptVersion: IMPROVE_PACK.promptVersion, modelId: IMPROVE_PACK.modelId },
      });
      expect(envelope.result.proposal).toMatchObject({
        applyTarget: { kind: 'profile', profileId: TAILOR_SOURCE.source.id },
        changes: [
          {
            target: { section: 'experience', entityId: ACME, field: 'achievements' },
            originalValue: ['Cut checkout latency by 40%'],
            proposedValue: ['Reduced checkout latency by 40%'],
            confirmation: { required: true },
          },
        ],
      });
      expect(guardrail.checked.join('\n')).toContain('Staff Engineer');
      expect(model.requests).toHaveLength(1);
      expect(JSON.stringify(model.requests[0])).not.toMatch(
        /nino@example\.com|Beridze|github\.com/,
      );
      expect(logs.join('\n')).not.toMatch(/checkout|Acme/);
    });

    it('is revoked when the operation does not fit the source, before any paid call', async () => {
      const jobId = await admit('improve_resume', { sections: [], targetRole: null });
      expect(await run(jobId)).toBe('failed');
      expect((await job(jobId))?.error?.code).toBe('revoked');
      expect(guardrail.checked).toHaveLength(0);
      expect(model.requests).toHaveLength(0);
    });
  });
});
