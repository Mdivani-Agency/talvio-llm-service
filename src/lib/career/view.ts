import {
  contentToPlainText,
  type CareerDocument,
  type CareerSection,
  type EvidenceRef,
  type SourceSnapshot,
} from '@talvio/llm-contracts';

import { SourceText } from '../parse/ground';

/*
 * What a session operation shows the model of a profile or resume (design §9), and the way back
 * from the model's citations to evidence. Every field is listed with a short handle ("F12"); the
 * model cites a handle and quotes from that field, and the service turns the pair into an evidence
 * reference with real offsets, or drops it.
 *
 * Contact details, names, links and recommendations are left out: analysis and questions do not
 * need them, so they never reach the model (contact minimization).
 */

export type ViewField = {
  handle: string;
  section: CareerSection;
  entityId: string | null;
  /** Field path inside the entity, e.g. `jobTitle` or `achievements.2`. */
  field: string;
  text: string;
};

export type CareerView = {
  fields: ViewField[];
  /** Entity ids the model may name as a target, with their section. */
  entities: Map<string, CareerSection>;
  /** The listing sent to the model. */
  text: string;
  /** Every field's text, for checks that look across the whole source (e.g. numbers). */
  allText: string;
};

export function careerView(document: CareerDocument): CareerView {
  const fields: ViewField[] = [];
  const entities = new Map<string, CareerSection>();
  const add = (section: CareerSection, entityId: string | null, field: string, text: unknown) => {
    if (typeof text !== 'string' || text.trim() === '') return;
    fields.push({ handle: `F${fields.length + 1}`, section, entityId, field, text });
  };

  add('person', null, 'role', document.person.role);
  add('person', null, 'tagline', document.person.tagline);
  add('person', null, 'seniority', document.person.seniority);
  add('location', null, 'city', document.location.city);
  add('location', null, 'country', document.location.country);

  for (const entry of document.experience) {
    entities.set(entry.id, 'experience');
    add('experience', entry.id, 'company', entry.company);
    add('experience', entry.id, 'jobTitle', entry.jobTitle);
    add('experience', entry.id, 'employmentType', entry.employmentType);
    add('experience', entry.id, 'locationType', entry.locationType);
    add('experience', entry.id, 'startDate', entry.startDate);
    add('experience', entry.id, 'endDate', entry.endDate);
    add('experience', entry.id, 'current', entry.current === null ? null : String(entry.current));
    if (entry.description) {
      add('experience', entry.id, 'description', contentToPlainText(entry.description));
    }
    entry.achievements.forEach((text, i) => add('experience', entry.id, `achievements.${i}`, text));
    entry.responsibilities.forEach((text, i) =>
      add('experience', entry.id, `responsibilities.${i}`, text),
    );
    entry.keyContributions.forEach((text, i) =>
      add('experience', entry.id, `keyContributions.${i}`, text),
    );
  }
  for (const entry of document.education) {
    entities.set(entry.id, 'education');
    add('education', entry.id, 'name', entry.name);
    add('education', entry.id, 'degreeType', entry.degreeType);
    add('education', entry.id, 'startDate', entry.startDate);
    add('education', entry.id, 'endDate', entry.endDate);
    add('education', entry.id, 'current', entry.current === null ? null : String(entry.current));
    if (entry.description) {
      add('education', entry.id, 'description', contentToPlainText(entry.description));
    }
  }
  for (const entry of document.projects) {
    entities.set(entry.id, 'projects');
    add('projects', entry.id, 'name', entry.name);
    if (entry.description) {
      add('projects', entry.id, 'description', contentToPlainText(entry.description));
    }
  }
  for (const section of ['skills', 'tools'] as const) {
    for (const item of document[section]) {
      entities.set(item.id, section);
      add(section, item.id, 'name', item.name);
    }
  }
  for (const item of document.languages) {
    entities.set(item.id, 'languages');
    add('languages', item.id, 'language', item.language);
    add('languages', item.id, 'proficiency', item.proficiency);
  }

  const text = fields
    .map(
      (f) =>
        `[${f.handle}] ${f.section}${f.entityId ? ` ${f.entityId}` : ''} ${f.field}: ${f.text.replace(/\s*\n\s*/g, ' / ')}`,
    )
    .join('\n');
  return { fields, entities, text, allText: fields.map((f) => f.text).join('\n') };
}

/** Grounds a model citation: the handle must exist and the quote must be in that field. */
export function groundCitation(
  view: CareerView,
  snapshot: SourceSnapshot,
  sourceHash: string,
  citation: { ref: string; quote: string | null },
): EvidenceRef | null {
  const field = view.fields.find((f) => f.handle === citation.ref.trim());
  if (!field) return null;
  const quote = citation.quote?.trim() ? citation.quote : null;
  const span = quote
    ? new SourceText(field.text).find(quote)
    : { start: 0, end: field.text.length };
  if (!span) return null;
  return {
    sourceKind: snapshot.source.kind,
    sourceHash,
    entityId: field.entityId,
    field: field.field,
    page: null,
    block: null,
    start: span.start,
    end: span.end,
    originalStart: null,
    originalEnd: null,
    excerpt: field.text.slice(span.start, span.end).slice(0, 500),
    clientSupplied: false,
    questionId: null,
    answerRevisionId: null,
  };
}

/** Evidence for a quoted span of free text such as a job description or an answer. */
export function groundText(
  text: string,
  quote: string,
  ref: Pick<EvidenceRef, 'sourceKind' | 'sourceHash' | 'questionId' | 'answerRevisionId'>,
): EvidenceRef | null {
  if (!quote.trim()) return null;
  const span = new SourceText(text).find(quote);
  if (!span) return null;
  return {
    ...ref,
    entityId: null,
    field: null,
    page: null,
    block: null,
    start: span.start,
    end: span.end,
    originalStart: null,
    originalEnd: null,
    excerpt: text.slice(span.start, span.end).slice(0, 500),
    clientSupplied: false,
  };
}
