import { z } from 'zod';

import { canonicalJson } from './canonical';
import { duplicateIds, idempotencyKeySchema, stableIdSchema, uuidSchema } from './primitives';
import { ApplyTarget, Proposal, applyTargetSchema } from './proposals';
import { SourceRef } from './source';
import { schemaVersionSchema } from './version';

/*
 * Apply contract. The web application performs the save in its own transaction (MDI-222);
 * this package defines the request and receipt so both sides agree on what was accepted.
 */

export type ProposalOperation = 'improve_profile' | 'improve_resume' | 'tailor_resume';

export class ApplyTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyTargetError';
  }
}

/**
 * The only apply target an operation may produce for a source. Results whose `applyTarget`
 * differs from this are invalid, which keeps two invariants in one place:
 * - a generated resume is never modified; edits go to its draft family;
 * - a job-specific variant is a new resume, never an edit of the source draft.
 */
export function applyTargetFor(operation: ProposalOperation, source: SourceRef): ApplyTarget {
  if (operation === 'tailor_resume') {
    return { kind: 'new_resume', resumeType: 'job_specific', derivedFrom: source };
  }
  if (operation === 'improve_profile') {
    if (source.kind !== 'profile') {
      throw new ApplyTargetError('improve_profile needs a profile source');
    }
    return { kind: 'profile', profileId: source.id, baseRevision: source.revision };
  }
  if (source.kind !== 'resume') {
    throw new ApplyTargetError('improve_resume needs a resume source');
  }
  if (source.state === 'generated') {
    return { kind: 'resume_draft_family', generatedResumeId: source.id };
  }
  return { kind: 'resume_draft', resumeId: source.id, baseRevision: source.revision };
}

export const applyRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  /** The succeeded job that produced the proposal. */
  jobId: uuidSchema,
  proposalId: uuidSchema,
  /** Replaying the same key with the same selections returns the original receipt. */
  idempotencyKey: idempotencyKeySchema,
  target: applyTargetSchema,
  /** For `new_resume`: the stable client draft id, so a retried create cannot duplicate it. */
  clientDraftId: uuidSchema.nullable(),
  selectedChangeIds: z.array(stableIdSchema).max(200),
  acceptedOmissionIds: z.array(stableIdSchema).max(200),
  confirmedClaimIds: z.array(stableIdSchema).max(200),
});

export const applyReceiptSchema = z.strictObject({
  receiptId: uuidSchema,
  proposalId: uuidSchema,
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('profile'), profileId: uuidSchema }),
    z.strictObject({ kind: z.literal('resume'), resumeId: uuidSchema }),
  ]),
  resultingRevision: z.string().min(1).max(64),
  appliedChangeIds: z.array(stableIdSchema),
  acceptedOmissionIds: z.array(stableIdSchema),
  /** True when this response replays an earlier identical apply. */
  replayed: z.boolean(),
});

export type ApplyRequest = z.infer<typeof applyRequestSchema>;
export type ApplyReceipt = z.infer<typeof applyReceiptSchema>;

export type ApplySelectionIssue =
  | { code: 'target_mismatch' }
  | { code: 'missing_client_draft_id' }
  | { code: 'unknown_change'; id: string }
  | { code: 'unknown_omission'; id: string }
  | { code: 'unconfirmed_claim'; changeId: string; claimId: string }
  | { code: 'duplicate_id'; id: string };

function sameTarget(left: ApplyTarget, right: ApplyTarget): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Checks an apply request against its proposal before any write. Returns every problem found;
 * an empty list means the selection is consistent. Revision checks against the live target
 * happen in the web's save transaction.
 */
export function checkApplySelection(
  proposal: Proposal,
  request: ApplyRequest,
): ApplySelectionIssue[] {
  const issues: ApplySelectionIssue[] = [];
  if (!sameTarget(proposal.applyTarget, request.target)) {
    issues.push({ code: 'target_mismatch' });
  }
  if (request.target.kind === 'new_resume' && !request.clientDraftId) {
    issues.push({ code: 'missing_client_draft_id' });
  }

  for (const id of [
    ...duplicateIds(request.selectedChangeIds),
    ...duplicateIds(request.acceptedOmissionIds),
  ]) {
    issues.push({ code: 'duplicate_id', id });
  }

  const changes = new Map(proposal.changes.map((change) => [change.id, change]));
  const confirmed = new Set(request.confirmedClaimIds);
  for (const id of request.selectedChangeIds) {
    const change = changes.get(id);
    if (!change) {
      issues.push({ code: 'unknown_change', id });
      continue;
    }
    if (change.confirmation.required) {
      for (const claim of change.confirmation.claims) {
        if (!confirmed.has(claim.id)) {
          issues.push({ code: 'unconfirmed_claim', changeId: id, claimId: claim.id });
        }
      }
    }
  }

  const omissions = new Set(proposal.omissions.map((omission) => omission.id));
  for (const id of request.acceptedOmissionIds) {
    if (!omissions.has(id)) {
      issues.push({ code: 'unknown_omission', id });
    }
  }
  return issues;
}
