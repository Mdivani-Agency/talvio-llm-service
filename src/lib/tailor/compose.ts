import {
  applyTargetFor,
  type CareerDocument,
  type Omission,
  type OperationResult,
  type SourceSnapshot,
  type Warning,
} from '@talvio/llm-contracts';

import { normalizeAnalysis } from '../analysis/normalize';
import type { CareerView } from '../career/view';
import { groundText } from '../career/view';
import { normalizeImprovement } from '../improve/normalize';
import type { AnswerInput } from '../prompts/session-input';
import { MAX_REQUIREMENTS, type RequirementsOutput, type TailorOutput } from '../prompts/tailor';

/*
 * Builds the tailor_resume result (design §§3, 5, 12; MDI-220) from the two model answers:
 * - requirements are kept only when quoted from the job description, and are never evidence for
 *   the candidate (src/lib/analysis);
 * - coverage that claims support without the candidate's own evidence becomes `missing`, and every
 *   requirement left `missing` is listed as unsupported, so gaps stay visible;
 * - field changes and additions pass the same fact checks as improvement (src/lib/improve): a skill
 *   is claimed only when the candidate's fields or answers name it;
 * - an omission names a whole entry with its original value and reason;
 * - the composed document is the source with exactly those changes applied: contacts, links,
 *   recommendations and every untouched field are copied as they are.
 * The worker never saves it: the web creates the new resume when the user accepts.
 */

export type TailorResult = OperationResult<'tailor_resume'>;

export type TailorContext = {
  proposalId: string;
  snapshot: SourceSnapshot;
  sourceHash: string;
  view: CareerView;
  answers: AnswerInput[];
  jobDescription: { text: string; hash: string };
};

/** Requirements the model quoted, kept only when found in the job description. */
export function groundRequirements(
  output: RequirementsOutput,
  jobDescription: string,
): { requirements: RequirementsOutput['requirements']; dropped: number } {
  const seen = new Set<string>();
  const requirements: RequirementsOutput['requirements'] = [];
  let dropped = 0;
  // Overlapping quotes could add up to more than the job description, which is the bound the
  // composition call was planned with (worstTailorMessage); keep their total within it.
  let bytesLeft = Buffer.byteLength(jobDescription);
  for (const requirement of output.requirements) {
    const ref = groundText(jobDescription, requirement.quote, {
      sourceKind: 'job_description',
      sourceHash: '0'.repeat(64),
      questionId: null,
      answerRevisionId: null,
    });
    if (!ref) {
      dropped += 1;
      continue;
    }
    const key = `${ref.start}:${ref.end}`;
    if (seen.has(key) || requirements.length >= MAX_REQUIREMENTS) continue;
    const bytes = Buffer.byteLength(ref.excerpt);
    if (bytes > bytesLeft) {
      dropped += 1;
      continue;
    }
    bytesLeft -= bytes;
    seen.add(key);
    requirements.push({ quote: ref.excerpt, kind: requirement.kind });
  }
  return { requirements, dropped };
}

/** Sections whose entries may be left out, with how to read an entry's id. */
const OMITTABLE = ['experience', 'education', 'projects', 'skills', 'tools', 'languages'] as const;
type Omittable = (typeof OMITTABLE)[number];

export function composeTailoring(
  requirements: RequirementsOutput['requirements'],
  output: TailorOutput,
  ctx: TailorContext,
): { result: TailorResult; warnings: Warning[]; complete: boolean } {
  const source = ctx.snapshot.document;

  const analysis = normalizeAnalysis(
    { requirements, coverage: output.coverage, findings: [] },
    {
      view: ctx.view,
      snapshot: ctx.snapshot,
      sourceHash: ctx.sourceHash,
      jobDescription: ctx.jobDescription,
      answers: ctx.answers,
      sections: [],
    },
  );

  // Omissions: whole entries only, each listed with its original value.
  const omitted = new Map<string, Omittable>();
  const omissions: Omission[] = [];
  let droppedOmissions = 0;
  for (const raw of output.omissions) {
    const entityId = raw.entityId.trim();
    const section = OMITTABLE.find((s) =>
      (source[s] as { id: string }[]).some((e) => e.id === entityId),
    );
    if (!section || omitted.has(entityId)) {
      droppedOmissions += 1;
      continue;
    }
    const entity = (source[section] as { id: string }[]).find((e) => e.id === entityId)!;
    omitted.set(entityId, section);
    omissions.push({
      id: `omission-${omissions.length + 1}`,
      section,
      entityId,
      field: null,
      originalValue: structuredClone(entity) as Omission['originalValue'],
      reason: raw.reason.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Less relevant to this job.',
    });
  }

  // Field changes and additions, with the same checks as improvement; none on an omitted entry.
  const improvement = normalizeImprovement(
    {
      changes: output.changes.filter((c) => !c.entityId || !omitted.has(c.entityId.trim())),
      additions: output.additions,
      summary: output.summary,
    },
    {
      operation: 'tailor_resume',
      proposalId: ctx.proposalId,
      snapshot: ctx.snapshot,
      sourceHash: ctx.sourceHash,
      view: ctx.view,
      answers: ctx.answers,
      sections: [],
      additionsFromSource: true,
    },
  );
  const { changes } = improvement.result.proposal;

  // The composed document: the source with the changes applied and the omissions removed.
  const document: CareerDocument = structuredClone(source);
  for (const change of changes) {
    if (change.type === 'add_entity') {
      const { section, entity } = change.addition;
      (document[section] as unknown[]).push(structuredClone(entity));
      continue;
    }
    const { section, entityId, field } = change.target;
    const value = structuredClone(change.proposedValue);
    if (section === 'person') {
      (document.person as Record<string, unknown>)[field] = value;
      continue;
    }
    const entry = (document[section] as { id: string }[]).find((e) => e.id === entityId);
    if (entry) (entry as Record<string, unknown>)[field] = value;
  }
  for (const [entityId, section] of omitted) {
    (document as Record<string, unknown>)[section] = (document[section] as { id: string }[]).filter(
      (e) => e.id !== entityId,
    );
  }

  const warnings = [...analysis.warnings, ...improvement.warnings];
  if (droppedOmissions) {
    warnings.push({
      code: 'omissions_dropped',
      message: `${droppedOmissions} suggested omission${droppedOmissions === 1 ? ' was' : 's were'} left out because ${droppedOmissions === 1 ? 'it' : 'they'} did not name a whole entry.`,
      entityId: null,
      page: null,
    });
  }

  const touched = changes.length + omissions.length;
  return {
    result: {
      proposal: {
        ...improvement.result.proposal,
        applyTarget: applyTargetFor('tailor_resume', ctx.snapshot.source),
        omissions,
        document,
        summary: touched
          ? improvement.result.proposal.summary === 'No changes are suggested.'
            ? `${touched} suggested change${touched === 1 ? '' : 's'} to review.`
            : improvement.result.proposal.summary
          : 'The resume is the source as it is; nothing was changed for this job.',
      },
      requirements: analysis.result.requirements,
      coverage: analysis.result.coverage,
      unsupportedRequirementIds: analysis.result.coverage
        .filter((c) => c.status === 'missing')
        .map((c) => c.requirementId),
    },
    warnings,
    complete: analysis.complete && improvement.complete,
  };
}
