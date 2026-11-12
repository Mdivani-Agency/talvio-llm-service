import {
  applyTargetFor,
  proposedChangeSchema,
  TARGETABLE_FIELDS,
  type CareerDocument,
  type ContentDoc,
  type EvidenceRef,
  type OperationResult,
  type ProposalOperation,
  type ProposedChange,
  type SourceSnapshot,
  type Warning,
} from '@talvio/llm-contracts';

import {
  buildContent,
  contentLines,
  type BuiltLine,
  type ContentLine,
  type ListKind,
} from '../career/content';
import { groundCitation, type CareerView } from '../career/view';
import type { ImproveOutput, TargetSection } from '../prompts/improve';
import type { AnswerInput } from '../prompts/session-input';
import { answerRef, conflictingEntities, lineSupport, mentions, type LineSupport } from './support';

/*
 * Turns the model's changed fields into a reviewable proposal (design §§5, 9, 12).
 * - Only targetable fields of entities in the source, in the requested sections, can change.
 * - Every original line the model leaves out is put back where it was: a proposal never erases a
 *   bullet or a paragraph, and an empty or partial answer changes nothing.
 * - Kept lines are copied exactly, marks and links included; a field whose lines all come back
 *   unchanged is not a change.
 * - Each new line is checked by rules (./support): unsupported facts block it, facts from answers
 *   make it a factual addition, and anything rules cannot show keeps its meaning becomes a claim
 *   the user must confirm. Entries whose facts conflict always need confirmation.
 * - Skills, tools and languages are added only when an answer names them.
 * The service returns the proposal; it never saves canonical content.
 */

export type ImproveOperation = 'improve_profile' | 'improve_resume';
export type ImproveResult = OperationResult<'improve_profile'>;

export type ImproveContext = {
  /** Tailoring reuses these rules for its field changes and additions. */
  operation: ProposalOperation;
  proposalId: string;
  snapshot: SourceSnapshot;
  sourceHash: string;
  /** The view the model saw, with description lines listed separately. */
  view: CareerView;
  /** Answered questions only: a skipped question is never a fact. */
  answers: AnswerInput[];
  sections: TargetSection[];
  /**
   * Tailoring only: a skill, tool or language the candidate's own text mentions elsewhere (a
   * bullet naming Kafka) may be added too, cited to that text and confirmed by the user.
   */
  additionsFromSource?: boolean;
};

const MAX_CLAIMS = 10;

type Entity = { section: TargetSection; entry: Record<string, unknown>; nearby: string };

function entities(document: CareerDocument): Map<string, Entity> {
  const found = new Map<string, Entity>();
  const join = (...values: unknown[]) =>
    values.filter((v) => typeof v === 'string' && v).join('\n');
  for (const e of document.experience) {
    found.set(e.id, {
      section: 'experience',
      entry: e,
      nearby: join(e.company, e.jobTitle, e.startDate, e.endDate, e.employmentType),
    });
  }
  for (const e of document.education) {
    found.set(e.id, {
      section: 'education',
      entry: e,
      nearby: join(e.name, e.degreeType, e.startDate, e.endDate),
    });
  }
  for (const e of document.projects) {
    found.set(e.id, { section: 'projects', entry: e, nearby: join(e.name) });
  }
  return found;
}

/** One line of text, without markup or list glyphs. */
const clean = (text: string | null) =>
  (text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(?:[•●▪◦*–-]|\d+[.)])\s+/, '')
    .trim();

type Pending = {
  section: TargetSection;
  entityId: string | null;
  field: string;
  reason: string;
};

export function normalizeImprovement(
  output: ImproveOutput,
  ctx: ImproveContext,
): { result: ImproveResult; warnings: Warning[]; complete: boolean } {
  const document = ctx.snapshot.document;
  const known = entities(document);
  const conflicts = conflictingEntities(document);
  const support = { sourceText: ctx.view.allText, answers: ctx.answers };
  const inScope = (section: TargetSection) =>
    section !== 'recommendations' && (!ctx.sections.length || ctx.sections.includes(section));

  const changes: ProposedChange[] = [];
  const seen = new Set<string>();
  const counts = { dropped: 0, blocked: 0, trimmed: 0 };
  let claimCount = 0;
  const claimId = () => `claim-${++claimCount}`;
  const evidenceOf = (handle: string | undefined): EvidenceRef[] => {
    if (!handle) return [];
    const ref = groundCitation(ctx.view, ctx.snapshot, ctx.sourceHash, {
      ref: handle,
      quote: null,
    });
    return ref ? [ref] : [];
  };
  const handleOf = (entityId: string | null, field: string) =>
    ctx.view.fields.find((f) => f.entityId === entityId && f.field === field)?.handle;

  const push = (
    pending: Pending,
    originalValue: unknown,
    proposedValue: unknown,
    lines: { text: string; support: LineSupport; newContent: boolean }[],
    evidence: EvidenceRef[],
  ) => {
    const conflict = pending.entityId ? conflicts.get(pending.entityId) : undefined;
    const claims = [
      ...(conflict
        ? [{ id: claimId(), text: `${conflict} Confirm the facts this change keeps.` }]
        : []),
      ...lines
        .filter((line) => line.support.status !== 'kept_words' || pending.field === 'role')
        .map((line) => ({ id: claimId(), text: line.text.slice(0, 500) })),
    ];
    const answered = lines.some((l) => l.support.status === 'from_answers' || l.newContent);
    const change = {
      id: `change-${changes.length + 1}`,
      type: 'field' as const,
      changeKind: answered ? ('factual_addition' as const) : ('rewrite' as const),
      target: { section: pending.section, entityId: pending.entityId, field: pending.field },
      originalValue: structuredClone(originalValue),
      proposedValue,
      reason: clean(pending.reason).slice(0, 500) || 'Clearer wording.',
      factIds: [],
      evidence: [
        ...evidence,
        ...lines.flatMap((l) => (l.support.status === 'from_answers' ? l.support.evidence : [])),
      ].slice(0, 20),
      confirmation: { required: claims.length > 0, claims },
    };
    const checked = proposedChangeSchema.safeParse(change);
    if (checked.success) {
      changes.push(checked.data);
    } else {
      counts.dropped += 1;
    }
  };

  for (const raw of output.changes) {
    const entityId = raw.entityId?.trim() || null;
    const entity = entityId ? known.get(entityId) : undefined;
    const section: TargetSection | null = entityId ? (entity?.section ?? null) : 'person';
    const key = `${entityId ?? '-'}:${raw.field}`;
    if (
      !section ||
      !inScope(section) ||
      !(TARGETABLE_FIELDS[section] as readonly string[]).includes(raw.field) ||
      seen.has(key)
    ) {
      counts.dropped += 1;
      continue;
    }
    seen.add(key);
    const pending: Pending = { section, entityId, field: raw.field, reason: raw.reason };

    if (section === 'person') {
      const field = raw.field as 'role' | 'tagline';
      const original = document.person[field];
      const value = clean(raw.value);
      if (!value || value === original) continue;
      const result = lineSupport(value, { original: original ?? '' }, support);
      if (result.status === 'blocked') {
        counts.blocked += 1;
        continue;
      }
      push(
        pending,
        original,
        value,
        [{ text: value, support: result, newContent: original === null }],
        evidenceOf(handleOf(null, field)),
      );
      continue;
    }

    const entry = entity!.entry;
    const isDescription = raw.field === 'description';
    const originalDoc = isDescription ? (entry.description as ContentDoc | null) : null;
    const originals: { text: string; line?: ContentLine }[] = isDescription
      ? originalDoc
        ? contentLines(originalDoc).map((line) => ({ text: line.text, line }))
        : []
      : (entry[raw.field] as string[]).map((text) => ({ text }));
    const prefix = isDescription ? 'description' : raw.field;
    const indexOf = new Map(
      originals.flatMap((_, i) => {
        const handle = handleOf(entityId, `${prefix}.${i}`);
        return handle ? [[handle, i] as const] : [];
      }),
    );

    type Item =
      | { keep: number }
      | { text: string; from: number[]; style: 'paragraph' | 'bullet' | null };
    const items: Item[] = [];
    const used = new Set<number>();
    const checkedLines: { text: string; support: LineSupport; newContent: boolean }[] = [];
    let confirmations = conflicts.has(entityId!) ? 1 : 0;
    for (const line of raw.lines) {
      const text = clean(line.text);
      if (text) {
        const named = [
          ...new Set(line.from.map((h) => indexOf.get(h.trim())).filter((i) => i !== undefined)),
        ];
        const from = named.filter((i) => !used.has(i));
        // A rewrite of lines already kept or rewritten would repeat them as new content.
        if (named.length && !from.length) {
          counts.dropped += 1;
          continue;
        }
        const original = from.map((i) => originals[i]!.text).join('\n');
        if (from.length === 1 && original === text) {
          used.add(from[0]!);
          items.push({ keep: from[0]! });
          continue;
        }
        const result = lineSupport(text, { original, nearby: entity!.nearby }, support);
        if (result.status === 'blocked') {
          counts.blocked += 1;
          continue;
        }
        if (result.status !== 'kept_words') {
          if (confirmations >= MAX_CLAIMS) {
            counts.trimmed += 1;
            continue;
          }
          confirmations += 1;
        }
        from.forEach((i) => used.add(i));
        items.push({ text, from, style: line.style });
        checkedLines.push({ text, support: result, newContent: from.length === 0 });
        continue;
      }
      const keep = line.keep ? indexOf.get(line.keep.trim()) : undefined;
      if (keep !== undefined && !used.has(keep)) {
        used.add(keep);
        items.push({ keep });
      }
    }

    // Put back every original line the answer left out, after the line that preceded it.
    const ordered: Item[] = [];
    let next = 0;
    const restoreBelow = (limit: number) => {
      for (; next < limit; next += 1) {
        if (!used.has(next)) ordered.push({ keep: next });
      }
    };
    for (const item of items) {
      const indexes = 'keep' in item ? [item.keep] : item.from;
      if (indexes.length) restoreBelow(Math.min(...indexes));
      ordered.push(item);
    }
    restoreBelow(originals.length);

    const unchanged = ordered.every((item, i) => 'keep' in item && item.keep === i);
    if (unchanged || !checkedLines.length) continue;

    // Evidence is what the new lines rewrite; kept lines speak for themselves.
    const evidence = [...new Set(ordered.flatMap((item) => ('from' in item ? item.from : [])))]
      .sort((a, b) => a - b)
      .flatMap((i) => {
        const handle = [...indexOf].find(([, index]) => index === i)?.[0];
        return evidenceOf(handle);
      });

    if (isDescription) {
      const kindOf = (item: Extract<Item, { text: string }>): 'paragraph' | ListKind => {
        if (item.style === 'paragraph') return 'paragraph';
        const kinds = item.from.map((i) => originals[i]!.line!.kind);
        if (item.style === 'bullet') {
          return kinds.find((k) => k !== 'paragraph') ?? 'bulletList';
        }
        return kinds.length && kinds.every((k) => k === kinds[0]) ? kinds[0]! : 'paragraph';
      };
      const built: BuiltLine[] = ordered.map((item) =>
        'keep' in item
          ? { kept: originals[item.keep]!.line! }
          : { text: item.text, kind: kindOf(item) },
      );
      push(pending, originalDoc, buildContent(built), checkedLines, evidence);
    } else {
      const bullets = ordered.map((item) =>
        'keep' in item ? originals[item.keep]!.text : item.text,
      );
      push(pending, entry[raw.field], bullets, checkedLines, evidence);
    }
  }

  // Additions: only what the candidate named in an answer, never already in the source.
  const added = new Set<string>();
  // An entity id must not repeat one in the source, such as an addition accepted earlier.
  const takenIds = new Set(
    Object.values(document).flatMap((section) =>
      Array.isArray(section)
        ? section.flatMap((e: unknown) => {
            const id = (e as { id?: unknown } | null)?.id;
            return typeof id === 'string' ? [id] : [];
          })
        : [],
    ),
  );
  const nextId = (section: string) => {
    let n = 1;
    while (takenIds.has(`added-${section}-${n}`)) n += 1;
    const id = `added-${section}-${n}`;
    takenIds.add(id);
    return id;
  };
  for (const raw of ctx.sections.length ? [] : output.additions) {
    const name = clean(raw.name).slice(0, 300);
    const existing =
      raw.section === 'languages'
        ? document.languages.map((l) => l.language)
        : document[raw.section].map((item) => item.name);
    const key = `${raw.section}:${name.toLowerCase()}`;
    if (!name || added.has(key) || existing.some((e) => e.toLowerCase() === name.toLowerCase())) {
      counts.dropped += 1;
      continue;
    }
    const answer = ctx.answers.find((a) => mentions(a.value, name));
    const sourceField = ctx.additionsFromSource
      ? ctx.view.fields.find((f) => mentions(f.text, name))
      : undefined;
    const ref = answer
      ? answerRef(answer, name)
      : sourceField
        ? groundCitation(ctx.view, ctx.snapshot, ctx.sourceHash, {
            ref: sourceField.handle,
            quote: name,
          })
        : null;
    if (!ref) {
      counts.blocked += 1;
      continue;
    }
    added.add(key);
    const id = nextId(raw.section);
    const addition =
      raw.section === 'languages'
        ? { section: raw.section, entity: { id, language: name, proficiency: null } }
        : { section: raw.section, entity: { id, name } };
    const claim =
      raw.section === 'languages'
        ? `You speak ${name}.`
        : `${name} belongs in your ${raw.section}.`;
    const change = proposedChangeSchema.safeParse({
      id: `change-${changes.length + 1}`,
      type: 'add_entity',
      changeKind: 'factual_addition',
      addition,
      reason:
        clean(raw.reason).slice(0, 500) ||
        (answer ? 'You named this in an answer.' : 'Your profile mentions this.'),
      factIds: [],
      evidence: [ref],
      confirmation: { required: true, claims: [{ id: claimId(), text: claim }] },
    });
    if (change.success) changes.push(change.data);
    else counts.dropped += 1;
  }

  const warnings: Warning[] = [];
  const warn = (code: string, message: string) =>
    warnings.push({ code, message, entityId: null, page: null });
  if (counts.blocked) {
    warn(
      'unsupported_changes_blocked',
      `${counts.blocked} suggested line${counts.blocked === 1 ? ' was' : 's were'} left out because ${counts.blocked === 1 ? 'it' : 'they'} stated facts that are not in your profile or answers.`,
    );
  }
  if (counts.dropped) {
    warn(
      'changes_dropped',
      `${counts.dropped} suggestion${counts.dropped === 1 ? ' was' : 's were'} left out because ${counts.dropped === 1 ? 'it' : 'they'} targeted a field that cannot change here or repeated another suggestion.`,
    );
  }
  if (counts.trimmed) {
    warn(
      'changes_trimmed',
      'Some rewritten lines were left out to keep each change to ten confirmations.',
    );
  }
  if (ctx.sections.includes('recommendations')) {
    warn(
      'section_not_improved',
      'Recommendations are written by other people and are not rewritten.',
    );
  }

  const summary = clean(output.summary);
  const safeSummary =
    summary && lineSupport(summary, { original: '' }, support).status !== 'blocked'
      ? summary.slice(0, 2_000)
      : changes.length
        ? `${changes.length} suggested change${changes.length === 1 ? '' : 's'} to review.`
        : 'No changes are suggested.';

  return {
    result: {
      proposal: {
        proposalId: ctx.proposalId,
        source: ctx.snapshot.source,
        sourceHash: ctx.sourceHash,
        applyTarget: applyTargetFor(ctx.operation, ctx.snapshot.source),
        changes,
        omissions: [],
        document: null,
        summary: changes.length ? safeSummary : 'No changes are suggested.',
      },
    },
    warnings,
    complete: true,
  };
}
