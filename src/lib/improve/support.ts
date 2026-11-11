import type { CareerDocument, EvidenceRef, PartialDate } from '@talvio/llm-contracts';

import { sha256Hex } from '../blob';
import { groundText } from '../career/view';
import type { AnswerInput } from '../prompts/session-input';

/*
 * Deterministic checks on a proposed line (design §9). The service cannot certify that a rewrite
 * keeps its meaning, so it only decides what rules can decide:
 * - a number, name or credential that appears nowhere in the candidate's text or answers is
 *   unsupported, and the line is blocked;
 * - one that comes from an answer makes the line a factual addition the user must confirm;
 * - one moved in from elsewhere in the source, a new content word, or a dropped negation or hedge
 *   means the meaning may have changed, so the user must confirm the line;
 * - otherwise (reordering, trimming, punctuation) the line keeps its source's words and needs no
 *   confirmation.
 */

export type LineSupport =
  | { status: 'kept_words' }
  | { status: 'confirm' }
  | { status: 'from_answers'; evidence: EvidenceRef[] }
  | { status: 'blocked'; unsupported: string[] };

export type SupportContext = {
  /** Every text of the candidate's source the model saw. */
  sourceText: string;
  answers: AnswerInput[];
};

const NUMBER = /\d+(?:[.,]\d+)*/g;
/** Capitalized or mixed tokens such as names, products and acronyms: Kafka, AWS, Node.js, C#. */
const NAME = /[A-Za-z0-9][A-Za-z0-9+#.&/-]*[A-Za-z0-9+#]|[A-Z]/g;
const CREDENTIAL =
  /\b(?:certified|certification|certificate|licen[cs]ed|licen[cs]e|accredited|degree|bachelor'?s?|master'?s?|ph\.?d|mba|diploma|chartered)\b/gi;
/** Words whose loss can reverse or weaken a claim. */
const POLARITY = [
  'not',
  'never',
  'no',
  'without',
  'assisted',
  'helped',
  'supported',
  'contributed',
  'partially',
  'partly',
  'some',
  'occasionally',
];
const STOPWORDS = new Set(
  'a an and are as at be by for from has have in into is it its of on or our that the their this to was were which while with within across over under via per more most less than then also both each other such own same so very can will just'.split(
    ' ',
  ),
);

const words = (text: string) => text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
const stem = (word: string) => word.replace(/'s$/, '').replace(/(?:ing|ed|es|s|ly)$/, '') || word;

function contains(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i').test(haystack);
}

/** Facts a rule can recognize in text: numbers, names and credentials. */
export function factTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const n of text.match(NUMBER) ?? []) tokens.add(n);
  for (const c of text.match(CREDENTIAL) ?? []) tokens.add(c);
  // A capitalized word that starts a sentence or line may be ordinary; the content-word rule
  // still sends it to confirmation if it is new.
  const sentences = text.split(/(?<=[.!?;:])\s+|\n+/);
  for (const sentence of sentences) {
    const found = [...sentence.matchAll(NAME)];
    found.forEach((match, i) => {
      const token = match[0].replace(/[.]+$/, '');
      const capitalized = /[A-Z]/.test(token);
      const technical = /\d|[+#]|[a-z][A-Z]|^[A-Z]{2,}$|\.[A-Za-z]/.test(token);
      if (!token || (!capitalized && !technical)) return;
      if (i === 0 && !technical) return;
      if (/^\d+$/.test(token)) return;
      tokens.add(token);
    });
  }
  return [...tokens];
}

/**
 * How a proposed line stands against what it replaces. `original` is the text of the lines it
 * rewrites; `nearby` is the rest of the same entry (employer, title, dates), whose facts the line
 * may name without moving them from elsewhere.
 */
export function lineSupport(
  text: string,
  { original, nearby = '' }: { original: string; nearby?: string },
  ctx: SupportContext,
): LineSupport {
  const unsupported: string[] = [];
  const evidence: EvidenceRef[] = [];
  let moved = false;
  for (const token of factTokens(text)) {
    if (contains(original, token) || contains(nearby, token)) continue;
    if (contains(ctx.sourceText, token)) {
      moved = true;
      continue;
    }
    const answer = ctx.answers.find((a) => contains(a.value, token));
    const ref = answer ? answerRef(answer, token) : null;
    if (ref) {
      evidence.push(ref);
      continue;
    }
    unsupported.push(token);
  }
  if (unsupported.length) return { status: 'blocked', unsupported };
  if (evidence.length) return { status: 'from_answers', evidence };

  const before = new Set(words(`${original}\n${nearby}`).map(stem));
  const added = words(text).filter((w) => !STOPWORDS.has(w) && !before.has(stem(w)));
  const lostPolarity = POLARITY.some((w) => contains(original, w) && !contains(text, w));
  return moved || added.length || lostPolarity ? { status: 'confirm' } : { status: 'kept_words' };
}

/** Evidence for a name or number the candidate gave in an answer. */
export function answerRef(answer: AnswerInput, quote: string): EvidenceRef | null {
  return groundText(answer.value, quote, {
    sourceKind: 'answer',
    sourceHash: sha256Hex(Buffer.from(answer.value, 'utf8')),
    questionId: answer.questionId,
    answerRevisionId: answer.answerRevisionId,
  });
}

/** True when `name` occurs as a whole term in `text`, ignoring case. */
export const mentions = contains;

const toMonths = (date: PartialDate | null): number | null => {
  if (!date) return null;
  const [year, month] = date.split('-').map(Number);
  return year! * 12 + ((month ?? 1) - 1);
};

/**
 * Entries whose facts contradict each other or another entry (design §9): an end before its
 * start, a role marked current that has an end date, or two full-time roles that overlap. A change
 * to one of them needs the user's confirmation that the facts it rests on are right.
 */
export function conflictingEntities(document: CareerDocument): Map<string, string> {
  const conflicts = new Map<string, string>();
  const periods = [...document.experience, ...document.education].map((entry) => ({
    entry,
    start: toMonths(entry.startDate),
    end: entry.current ? Infinity : toMonths(entry.endDate),
  }));
  for (const { entry, start, end } of periods) {
    if (start !== null && end !== null && end < start) {
      conflicts.set(entry.id, 'This entry ends before it starts.');
    } else if (entry.current && entry.endDate) {
      conflicts.set(entry.id, 'This entry is marked current but has an end date.');
    }
  }
  const fullTime = document.experience
    .map((entry) => ({
      entry,
      start: toMonths(entry.startDate),
      end: entry.current ? Infinity : toMonths(entry.endDate),
    }))
    .filter(
      (p): p is typeof p & { start: number; end: number } =>
        p.entry.employmentType === 'full-time' && p.start !== null && p.end !== null,
    );
  for (const [i, a] of fullTime.entries()) {
    for (const b of fullTime.slice(i + 1)) {
      if (a.start < b.end && b.start < a.end) {
        const message = 'This full-time role overlaps another full-time role.';
        if (!conflicts.has(a.entry.id)) conflicts.set(a.entry.id, message);
        if (!conflicts.has(b.entry.id)) conflicts.set(b.entry.id, message);
      }
    }
  }
  return conflicts;
}
