import type { Operation } from '@talvio/llm-contracts';

import { CORE_FIELDS, rates, type FieldCounts } from './score';
import type { Report } from './run';

/*
 * Release gates (design §14). A prompt, model or pipeline release ships only when every gate
 * passes on the full evaluation set. A gate that needs a human (question usefulness) is
 * `pending` until its ratings are supplied; pending blocks a release like a failure does.
 */

export const THRESHOLDS = {
  minDocuments: 50,
  minJobDescriptions: 20,
  /** Precision and recall, each, for every core extraction field. */
  extraction: 0.95,
  fabrications: 0,
  injectionHits: 0,
  preservation: 1,
  schemaValid: 1,
  /** Jobs per operation that succeeded or were refused as expected (blocked injections). */
  completion: 1,
  questionUseful: 0.9,
  jobCapMicroUsd: 50_000,
  p95MicroUsd: 40_000,
} as const;

/** p95 latency objectives per operation (design §13). */
export const LATENCY_P95_MS: Partial<Record<Operation, number>> = {
  parse_document: 30_000,
  generate_questions: 30_000,
  analyze_resume: 90_000,
  improve_profile: 90_000,
  improve_resume: 90_000,
  tailor_resume: 90_000,
};

export type GateStatus = 'pass' | 'fail' | 'pending';
export type GateResult = {
  gate: string;
  status: GateStatus;
  value: number | null;
  threshold: number;
};

const atLeast = (gate: string, value: number, threshold: number): GateResult => ({
  gate,
  status: value >= threshold ? 'pass' : 'fail',
  value,
  threshold,
});
const atMost = (gate: string, value: number, threshold: number): GateResult => ({
  gate,
  status: value <= threshold ? 'pass' : 'fail',
  value,
  threshold,
});

function extractionGates(scope: string, counts: FieldCounts): GateResult[] {
  return CORE_FIELDS.flatMap((field) => {
    const { precision, recall } = rates(counts[field]);
    return [
      atLeast(`extraction.${scope}.${field}.precision`, precision, THRESHOLDS.extraction),
      atLeast(`extraction.${scope}.${field}.recall`, recall, THRESHOLDS.extraction),
    ];
  });
}

export function evaluateGates(report: Omit<Report, 'gates'>): GateResult[] {
  const gates: GateResult[] = [
    atLeast('set.documents', report.set.documents, THRESHOLDS.minDocuments),
    atLeast('set.jobDescriptions', report.set.jobDescriptions, THRESHOLDS.minJobDescriptions),
    ...extractionGates('all', report.extraction.all),
    // Reported per source type, and each source type must meet the bar on its own.
    ...Object.entries(report.extraction.bySourceType).flatMap(([type, counts]) =>
      extractionGates(type, counts),
    ),
    atMost('injection.structuredHits', report.injectionHits, THRESHOLDS.injectionHits),
    atMost('proposals.fabrications', report.proposals.fabrications, THRESHOLDS.fabrications),
    atLeast(
      'proposals.preservation',
      report.proposals.checked === 0
        ? 1
        : (report.proposals.checked - report.proposals.lost) / report.proposals.checked,
      THRESHOLDS.preservation,
    ),
    atLeast(
      'schema.valid',
      report.schema.succeeded === 0 ? 0 : report.schema.valid / report.schema.succeeded,
      THRESHOLDS.schemaValid,
    ),
  ];
  for (const [operation, stats] of Object.entries(report.operations)) {
    gates.push(
      atLeast(
        `completion.${operation}`,
        stats.runs === 0 ? 0 : stats.completed / stats.runs,
        THRESHOLDS.completion,
      ),
    );
    gates.push(atMost(`cost.${operation}.max`, stats.maxMicroUsd, THRESHOLDS.jobCapMicroUsd));
    gates.push(atMost(`cost.${operation}.p95`, stats.p95MicroUsd, THRESHOLDS.p95MicroUsd));
    const latency = LATENCY_P95_MS[operation as Operation];
    if (latency !== undefined) gates.push(atMost(`latency.${operation}.p95`, stats.p95Ms, latency));
  }
  const { asked, rated, useful } = report.questions;
  gates.push(
    rated < asked || asked === 0
      ? {
          gate: 'questions.useful',
          status: 'pending',
          value: null,
          threshold: THRESHOLDS.questionUseful,
        }
      : atLeast('questions.useful', useful / rated, THRESHOLDS.questionUseful),
  );
  return gates;
}

export const releasable = (gates: GateResult[]) => gates.every((gate) => gate.status === 'pass');
