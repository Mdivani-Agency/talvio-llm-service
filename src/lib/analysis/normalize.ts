import type {
  CareerSection,
  EvidenceRef,
  OperationResult,
  SourceSnapshot,
  Warning,
} from '@talvio/llm-contracts';

import { sha256Hex } from '../blob';
import { groundCitation, groundText, type CareerView } from '../career/view';
import type { AnalysisOutput } from '../prompts/analyze-resume';
import type { AnswerInput } from '../prompts/session-input';

/*
 * Turns the model's analysis into a contract result (design §§5, 9). Every citation is grounded or
 * dropped; requirements must be quoted from the job description; coverage that claims support
 * without candidate evidence becomes `missing`. Findings that need evidence and have none, that
 * fall outside the requested sections or that rate the resume with a score are dropped.
 */

export type AnalysisResult = OperationResult<'analyze_resume'>;

export type AnalysisContext = {
  view: CareerView;
  snapshot: SourceSnapshot;
  sourceHash: string;
  jobDescription: { text: string; hash: string } | null;
  answers: AnswerInput[];
  sections: CareerSection[];
};

/** Findings about wording or support must point at the words they are about. */
const NEEDS_EVIDENCE = new Set(['weak_evidence', 'clarity', 'impact', 'consistency']);

/** "ATS score", "85% match" and the like: the service does not rate resumes. */
const SCORE_CLAIM = /\bATS\b|\b\d{1,3}\s*%\s*(?:match|fit|score|compatib)|\bscore\b/i;

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

export function answerEvidence(
  answers: AnswerInput[],
  citation: { ref: string; quote: string | null },
): EvidenceRef | null {
  const answer = answers.find((a) => a.handle === citation.ref.trim());
  if (!answer) return null;
  return groundText(answer.value, citation.quote?.trim() ? citation.quote : answer.value, {
    sourceKind: 'answer',
    sourceHash: sha256Hex(Buffer.from(answer.value, 'utf8')),
    questionId: answer.questionId,
    answerRevisionId: answer.answerRevisionId,
  });
}

/** Candidate-side evidence only: a field of the source or one of the user's answers. */
export function candidateEvidence(
  ctx: Pick<AnalysisContext, 'view' | 'snapshot' | 'sourceHash' | 'answers'>,
  citations: { ref: string; quote: string | null }[],
): { refs: EvidenceRef[]; dropped: number } {
  const refs: EvidenceRef[] = [];
  let dropped = 0;
  for (const citation of citations) {
    const ref = citation.ref.trim().startsWith('A')
      ? answerEvidence(ctx.answers, citation)
      : groundCitation(ctx.view, ctx.snapshot, ctx.sourceHash, citation);
    if (ref) refs.push(ref);
    else dropped += 1;
  }
  return { refs, dropped };
}

export function normalizeAnalysis(
  output: AnalysisOutput,
  ctx: AnalysisContext,
): { result: AnalysisResult; warnings: Warning[]; complete: boolean } {
  const warnings: Warning[] = [];
  const warn = (code: string, message: string, entityId: string | null = null) =>
    warnings.push({ code, message, entityId, page: null });
  let complete = true;
  let droppedCitations = 0;

  // Requirements, quoted from the job description.
  const requirements: AnalysisResult['requirements'] = [];
  const requirementIds = new Map<number, string>();
  if (ctx.jobDescription) {
    const jd = ctx.jobDescription;
    const seen = new Set<string>();
    output.requirements.forEach((requirement, index) => {
      const ref = groundText(jd.text, requirement.quote, {
        sourceKind: 'job_description',
        sourceHash: jd.hash,
        questionId: null,
        answerRevisionId: null,
      });
      if (!ref) {
        complete = false;
        warn(
          'requirement_not_found',
          'A requirement could not be found in the job description, so it was left out.',
        );
        return;
      }
      const key = `${ref.start}:${ref.end}`;
      if (seen.has(key) || requirements.length >= 50) return;
      seen.add(key);
      const id = `req-${requirements.length + 1}`;
      requirementIds.set(index, id);
      requirements.push({ id, text: ref.excerpt, kind: requirement.kind, evidence: [ref] });
    });
    if (requirements.length === 0) {
      complete = false;
      warn('no_requirements_found', 'No requirements could be read from the job description.');
    }
  }

  // Coverage: one entry per requirement, support only with the candidate's own evidence.
  const coverage: AnalysisResult['coverage'] = requirements.map((requirement) => {
    const claimed = output.coverage.find(
      (c) => requirementIds.get(c.requirement) === requirement.id,
    );
    if (!claimed) {
      return { requirementId: requirement.id, status: 'missing', evidence: [], note: null };
    }
    const { refs, dropped } = candidateEvidence(ctx, claimed.evidence);
    droppedCitations += dropped;
    if (claimed.status !== 'missing' && refs.length === 0) {
      return {
        requirementId: requirement.id,
        status: 'missing',
        evidence: [],
        note: 'Nothing in the profile or answers shows this yet.',
      };
    }
    return {
      requirementId: requirement.id,
      status: claimed.status,
      evidence: claimed.status === 'missing' ? [] : refs.slice(0, 10),
      note: claimed.note?.slice(0, 500) ?? null,
    };
  });

  // Findings.
  const findings: AnalysisResult['findings'] = [];
  let droppedFindings = 0;
  for (const finding of output.findings) {
    if (findings.length >= 50) break;
    const inScope =
      ctx.sections.length === 0 ||
      finding.section === null ||
      ctx.sections.includes(finding.section);
    const requirementId =
      finding.requirement === null ? undefined : requirementIds.get(finding.requirement);
    if (!inScope || SCORE_CLAIM.test(finding.message)) {
      droppedFindings += 1;
      continue;
    }
    if (finding.category === 'job_match' && !requirementId) {
      droppedFindings += 1;
      continue;
    }
    const { refs, dropped } = candidateEvidence(ctx, finding.evidence);
    droppedCitations += dropped;
    if (NEEDS_EVIDENCE.has(finding.category) && refs.length === 0) {
      droppedFindings += 1;
      continue;
    }
    const requirement = requirements.find((r) => r.id === requirementId);
    const entityId =
      finding.entityId && ctx.view.entities.has(finding.entityId) ? finding.entityId : null;
    findings.push({
      id: `finding-${findings.length + 1}`,
      severity: finding.severity,
      category: finding.category,
      section: entityId ? (ctx.view.entities.get(entityId) ?? finding.section) : finding.section,
      entityId,
      message: finding.message.slice(0, 500),
      evidence: [...refs, ...(requirement?.evidence ?? [])].slice(0, 10),
    });
  }
  if (droppedFindings) {
    warn(
      'findings_dropped',
      `${droppedFindings} finding${droppedFindings === 1 ? ' was' : 's were'} left out because ${droppedFindings === 1 ? 'it was' : 'they were'} unsupported or out of scope.`,
    );
  }
  if (droppedCitations) {
    warn(
      'citation_not_found',
      `${droppedCitations} cited passage${droppedCitations === 1 ? ' was' : 's were'} not found in the source and ${droppedCitations === 1 ? 'was' : 'were'} left out.`,
    );
  }

  // The model lists the most important first; severity decides, then its order.
  const priorities = findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] || a.index - b.index,
    )
    .map(({ finding }) => finding.id);

  return {
    result: { findings, requirements, coverage, priorities },
    warnings,
    complete,
  };
}
