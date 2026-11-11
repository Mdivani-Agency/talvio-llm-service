import type { OperationResult, Question, Warning } from '@talvio/llm-contracts';

import type { CareerView } from '../career/view';
import type { QuestionsOutput } from '../prompts/generate-questions';

/*
 * Turns the model's questions into the set the session issues (design §12). A question is kept
 * only when it points at a real gap (a source entity or section, an analysis finding or a job
 * requirement), its topic was not asked before in the session, and it states no number the
 * candidate's text does not contain. Question ids are issued here, never by the model.
 */

export type QuestionsContext = {
  round: number;
  /** Questions this set may issue: the job's request, within what the session has left. */
  slots: number;
  view: CareerView;
  /** Text numbers may be quoted from: the source and the job description. */
  knownText: string;
  askedTopics: Set<string>;
  analysis: OperationResult<'analyze_resume'> | null;
};

const TOPIC = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const NUMBER = /\d+(?:[.,]\d+)*/g;

export function topicKeyOf(raw: string): string | null {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[._-]{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64)
    .replace(/[._-]+$/, '');
  return TOPIC.test(key) ? key : null;
}

/** Numbers in `text` that `known` does not contain. */
function inventedNumbers(text: string, known: string): string[] {
  return (text.match(NUMBER) ?? []).filter((n) => !known.includes(n));
}

export function normalizeQuestions(
  output: QuestionsOutput,
  ctx: QuestionsContext,
): { questions: Question[]; warnings: Warning[] } {
  const findings = new Set(ctx.analysis?.findings.map((f) => f.id) ?? []);
  const requirements = new Set(ctx.analysis?.requirements.map((r) => r.id) ?? []);
  const topics = new Set(ctx.askedTopics);
  const questions: Question[] = [];
  const dropped = { repeated: 0, invented: 0, untargeted: 0 };

  for (const raw of output.questions) {
    if (questions.length >= ctx.slots) break;
    const topicKey = topicKeyOf(raw.topicKey);
    if (!topicKey || topics.has(topicKey)) {
      dropped.repeated += 1;
      continue;
    }
    if (inventedNumbers(`${raw.prompt} ${raw.reason}`, ctx.knownText).length) {
      dropped.invented += 1;
      continue;
    }
    const targetEntityId =
      raw.targetEntityId && ctx.view.entities.has(raw.targetEntityId) ? raw.targetEntityId : null;
    const requirementIds = [...new Set(raw.requirementIds.filter((id) => requirements.has(id)))];
    const findingId = raw.findingId && findings.has(raw.findingId) ? raw.findingId : null;
    const targetSection = targetEntityId
      ? (ctx.view.entities.get(targetEntityId) ?? raw.targetSection)
      : raw.targetSection;
    if (!targetEntityId && !targetSection && !findingId && requirementIds.length === 0) {
      dropped.untargeted += 1;
      continue;
    }
    topics.add(topicKey);
    questions.push({
      id: `r${ctx.round}-q${questions.length + 1}`,
      topicKey,
      prompt: raw.prompt.trim().slice(0, 500),
      // Guidance never carries a number: it must not read as a suggested answer.
      guidance: raw.guidance && !/\d/.test(raw.guidance) ? raw.guidance.trim().slice(0, 500) : null,
      reason: raw.reason.trim().slice(0, 500),
      targetSection,
      targetEntityId,
      requirementIds,
    });
  }

  const warnings: Warning[] = [];
  const total = dropped.repeated + dropped.invented + dropped.untargeted;
  if (total) {
    warnings.push({
      code: 'questions_dropped',
      message: `${total} question${total === 1 ? ' was' : 's were'} left out because ${total === 1 ? 'it' : 'they'} repeated an earlier topic, stated numbers the profile does not contain, or pointed at no gap.`,
      entityId: null,
      page: null,
    });
  }
  return { questions, warnings };
}
