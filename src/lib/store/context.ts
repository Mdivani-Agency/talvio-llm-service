import { randomUUID } from 'crypto';

import type { ContextRevision } from '@talvio/llm-contracts';

import { contentHash } from '../hash';
import type { ContextInput } from './types';

/** The first revision of a session's context. */
export function firstContext(sessionId: string, context: ContextInput, now: Date): ContextRevision {
  return {
    contextRevisionId: randomUUID(),
    sessionId,
    contextHash: context.contextHash,
    sourceHash: context.sourceHash,
    jobDescriptionHash: context.jobDescriptionHash,
    answerRevisionId: null,
    createdAt: now.toISOString(),
  };
}

/** The revision that follows `previous` once answers are folded in. */
export function answeredContext(
  previous: ContextRevision,
  answersHash: string,
  now: Date,
): { context: ContextRevision; answerRevisionId: string } {
  const answerRevisionId = randomUUID();
  return {
    answerRevisionId,
    context: {
      ...previous,
      contextRevisionId: randomUUID(),
      contextHash: contentHash({ previous: previous.contextHash, answersHash }),
      answerRevisionId,
      createdAt: now.toISOString(),
    },
  };
}
