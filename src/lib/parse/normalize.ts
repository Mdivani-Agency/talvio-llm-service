import {
  LIMITS,
  type CareerDocument,
  type ContentDoc,
  type EvidenceRef,
  type Fact,
  type ParseDocumentResult,
  type Warning,
} from '@talvio/llm-contracts';

import type { ModelOutput } from '../prompts/parse-document';
import { readDate } from './dates';
import { SourceText, uncoveredLines, type Span } from './ground';

/*
 * Turns the model's quotes into a contract result (design §5, §9). Every kept value is the
 * source's own text at a recorded offset; a value that cannot be found, does not fit its field or
 * names an unreadable date is left null and listed as an uncertainty, and resume text that ended
 * up in no field is listed as a warning. Any of those makes the result `partial`, so it never
 * looks complete when something was not carried over.
 */

type Uncertainty = ParseDocumentResult['uncertainties'][number];
type Section = Uncertainty['section'];
type Predicate = Fact['predicate'];

export type SourceMeta = {
  sourceHash: string;
  /** Text the browser extracted or the user pasted; the server did not read the original file. */
  clientSupplied: boolean;
  /** Page ranges in the text, from the browser's extraction manifest. */
  pages: { page: number; start: number; end: number }[];
};

export type Normalized = {
  career: CareerDocument;
  facts: Fact[];
  uncertainties: Uncertainty[];
  warnings: Warning[];
  /** False when anything was left empty, cut at a limit or not placed. */
  complete: boolean;
};

const MAX_FACTS = 1_000;
const MAX_UNCERTAINTIES = 200;
const MAX_WARNINGS = 100;
const UNACCOUNTED_REPORTED = 20;

const EMPLOYMENT_WORDS: Record<string, RegExp> = {
  'full-time': /full[\s-]?time/i,
  'part-time': /part[\s-]?time/i,
  contract: /contract|contractor|freelance/i,
  'self-employed': /self[\s-]?employed|freelance|founder|own business/i,
  volunteer: /volunteer/i,
  internship: /intern(ship)?\b/i,
  apprenticeship: /apprentice/i,
  seasonal: /seasonal/i,
};
const LOCATION_WORDS: Record<string, RegExp> = {
  remote: /remote/i,
  hybrid: /hybrid/i,
  office: /on[\s-]?site|in[\s-]office|office[\s-]based/i,
};
const PROFICIENCY_WORDS: Record<string, RegExp> = {
  beginner: /beginner|basic|elementary|\bA[12]\b/i,
  intermediate: /intermediate|conversational|working|\bB[12]\b/i,
  fluent: /fluent|advanced|proficient|professional|\bC[12]\b/i,
  native: /native|mother tongue|bilingual/i,
};

/** End of the clause a span sits in: the next separator outside parentheses, or the line end. */
function clauseEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '[') depth += 1;
    else if ((c === ')' || c === ']') && depth > 0) depth -= 1;
    else if (c === '\n' || (depth === 0 && (c === ',' || c === ';' || c === '|' || c === '•')))
      return i;
  }
  return text.length;
}

export function normalizeParse(output: ModelOutput, text: string, meta: SourceMeta): Normalized {
  const source = new SourceText(text);
  const facts: Fact[] = [];
  const uncertainties: Uncertainty[] = [];
  const warnings: Warning[] = [];
  const spans: Span[] = [];
  let complete = true;
  let factsCut = false;
  let uncertaintiesCut = false;

  const pageOf = (at: number) =>
    meta.pages.find((page) => at >= page.start && at < Math.max(page.end, page.start + 1))?.page ??
    null;

  const evidence = (span: Span, entityId: string | null, field: string | null): EvidenceRef => ({
    sourceKind: 'document',
    sourceHash: meta.sourceHash,
    entityId,
    field,
    page: pageOf(span.start),
    block: null,
    start: span.start,
    end: span.end,
    originalStart: null,
    originalEnd: null,
    excerpt: text.slice(span.start, Math.min(span.end, span.start + 500)),
    clientSupplied: meta.clientSupplied,
    questionId: null,
    answerRevisionId: null,
  });

  const warn = (warning: Omit<Warning, 'entityId' | 'page'> & Partial<Warning>) => {
    // Every warning here means something was not carried over.
    complete = false;
    if (warnings.length < MAX_WARNINGS - 1) {
      warnings.push({ entityId: null, page: null, ...warning });
    }
  };

  const uncertain = (
    section: Section,
    entityId: string | null,
    field: string | null,
    reason: Uncertainty['reason'],
    message: string,
    span: Span | null = null,
  ) => {
    complete = false;
    if (uncertainties.length >= MAX_UNCERTAINTIES) {
      uncertaintiesCut = true;
      return;
    }
    uncertainties.push({
      id: `uncertain:${uncertainties.length}`,
      section,
      entityId,
      field,
      reason,
      message,
      evidence: span ? [evidence(span, entityId, field)] : [],
    });
  };

  const fact = (
    predicate: Predicate,
    section: Section | null,
    entityId: string | null,
    field: string,
    value: string,
    span: Span,
    extra: Partial<Fact> = {},
  ) => {
    if (facts.length >= MAX_FACTS) {
      factsCut = true;
      return;
    }
    facts.push({
      id: `fact:${facts.length}`,
      subjectEntityId: entityId,
      section,
      predicate,
      value: value.slice(0, 1_000),
      quantity: null,
      unit: null,
      qualifiers: [],
      negated: false,
      date: null,
      datePrecision: null,
      status: 'supported',
      evidence: [evidence(span, entityId, field)],
      ...extra,
    });
  };

  /** Finds a quoted value in the source; null (and an uncertainty) when it is not there or too long. */
  const ground = (
    value: string | null,
    at: {
      section: Section;
      entityId: string | null;
      field: string;
      max: number;
      from?: number;
      near?: Span;
    },
  ): { text: string; span: Span } | null => {
    if (value === null || value.trim() === '') return null;
    const span = at.near ? source.findNear(value, at.near) : source.find(value, at.from ?? 0);
    if (!span) {
      uncertain(
        at.section,
        at.entityId,
        at.field,
        'ambiguous',
        'A value was not found in the resume text, so it was left empty.',
      );
      return null;
    }
    spans.push(span);
    const found = source.slice(span);
    if (found.length > at.max) {
      uncertain(
        at.section,
        at.entityId,
        at.field,
        'incomplete',
        'A value is longer than this field allows, so it was left empty.',
        span,
      );
      return null;
    }
    return { text: found, span };
  };

  const doc = (value: string): ContentDoc => ({
    type: 'doc',
    blocks: [{ type: 'paragraph', content: [{ text: value }] }],
  });

  /** Keeps a stated classification only when its wording appears near the entity. */
  const stated = <T extends string>(
    value: T | null,
    words: Record<string, RegExp>,
    region: Span | null,
  ): T | null => {
    if (value === null || region === null) return null;
    const window = text.slice(Math.max(0, region.start - 200), region.end + 200);
    return words[value]?.test(window) ? value : null;
  };

  const regionOf = (found: Span[]): Span | null =>
    found.length === 0
      ? null
      : {
          start: Math.min(...found.map((span) => span.start)),
          end: Math.max(...found.map((span) => span.end)),
        };

  /** Start and end date text read into the contract's period fields. */
  const period = (
    section: Section,
    entityId: string,
    start: string | null,
    end: string | null,
    from: number,
  ) => {
    const out = {
      startDate: null as string | null,
      endDate: null as string | null,
      current: null as boolean | null,
      spans: [] as Span[],
    };
    const read = (value: string | null, field: 'startDate' | 'endDate') => {
      const found = ground(value, { section, entityId, field, max: 100, from });
      if (!found) return;
      out.spans.push(found.span);
      const date = readDate(found.text);
      if (date.kind === 'present' && field === 'endDate') {
        out.current = true;
        fact('current_role', section, entityId, field, found.text, found.span);
        return;
      }
      if (date.kind === 'date') {
        out[field] = date.value;
        fact(
          field === 'startDate' ? 'start_date' : 'end_date',
          section,
          entityId,
          field,
          found.text,
          found.span,
          { date: date.value, datePrecision: date.precision },
        );
        return;
      }
      uncertain(
        section,
        entityId,
        field,
        'unknown_date',
        'This date could not be read, so it was left empty.',
        found.span,
      );
    };
    read(start, 'startDate');
    read(end, 'endDate');
    if (out.endDate !== null) out.current = false;
    return out;
  };

  /** Applies a section limit; what does not fit is reported, never dropped quietly. */
  const capped = <T>(items: T[], max: number, section: string): T[] => {
    if (items.length <= max) return items;
    warn({
      code: 'section_limit',
      message: `Only the first ${max} entries of ${section} were kept. Review the original for the rest.`,
    });
    return items.slice(0, max);
  };

  // person, contacts, location
  const person = output.person;
  const firstName = ground(person.firstName, {
    section: 'person',
    entityId: null,
    field: 'firstName',
    max: LIMITS.shortTextChars,
  });
  const lastName = ground(person.lastName, {
    section: 'person',
    entityId: null,
    field: 'lastName',
    max: LIMITS.shortTextChars,
  });
  const role = ground(person.role, {
    section: 'person',
    entityId: null,
    field: 'role',
    max: LIMITS.shortTextChars,
  });
  const tagline = ground(person.tagline, {
    section: 'person',
    entityId: null,
    field: 'tagline',
    max: LIMITS.longTextChars,
  });
  if (role) fact('job_title', 'person', null, 'role', role.text, role.span);

  // Contacts are legitimate in a parse result (design §9); they are not copied into facts.
  const email = ground(output.contacts.email, {
    section: 'contacts',
    entityId: null,
    field: 'email',
    max: LIMITS.shortTextChars,
  });
  const phone = ground(output.contacts.phone, {
    section: 'contacts',
    entityId: null,
    field: 'phone',
    max: LIMITS.shortTextChars,
  });
  const url = ground(output.contacts.url, {
    section: 'contacts',
    entityId: null,
    field: 'url',
    max: LIMITS.shortTextChars,
  });

  const city = ground(output.location.city, {
    section: 'location',
    entityId: null,
    field: 'city',
    max: LIMITS.shortTextChars,
  });
  const country = ground(output.location.country, {
    section: 'location',
    entityId: null,
    field: 'country',
    max: LIMITS.shortTextChars,
  });
  for (const place of [city, country]) {
    if (place) fact('location', 'location', null, 'location', place.text, place.span);
  }

  // experience
  let anchor = 0;
  const experience = capped(output.experience, LIMITS.entriesPerSection, 'experience').map(
    (entry, index) => {
      const id = `parsed:experience:${index}`;
      const at = (field: string, max: number = LIMITS.shortTextChars) => ({
        section: 'experience' as const,
        entityId: id,
        field,
        max,
        from: anchor,
      });
      const company = ground(entry.company, at('company'));
      const jobTitle = ground(entry.jobTitle, { ...at('jobTitle'), near: company?.span });
      const found = [company?.span, jobTitle?.span].filter((span): span is Span => !!span);
      const next = regionOf(found);
      if (next) anchor = next.start;
      if (company) fact('employer', 'experience', id, 'company', company.text, company.span);
      if (jobTitle) fact('job_title', 'experience', id, 'jobTitle', jobTitle.text, jobTitle.span);
      const dates = period('experience', id, entry.start, entry.end, anchor);
      const summary = ground(entry.summary, at('description', LIMITS.longTextChars));

      const buckets = {
        achievement: [] as string[],
        responsibility: [] as string[],
        contribution: [] as string[],
      };
      const bulletSpans: Span[] = [];
      for (const bullet of entry.bullets) {
        const kept = ground(bullet.text, at(`${bullet.kind}s`, LIMITS.longTextChars));
        if (!kept) continue;
        bulletSpans.push(kept.span);
        buckets[bullet.kind].push(kept.text);
        fact(
          bullet.kind === 'responsibility' ? 'responsibility' : 'achievement',
          'experience',
          id,
          bullet.kind,
          kept.text,
          kept.span,
        );
      }
      const region = regionOf([...found, ...dates.spans, ...bulletSpans]);
      const limit = (items: string[]) => {
        if (items.length > LIMITS.bulletsPerEntry) {
          warn({
            code: 'bullet_limit',
            message: `Only the first ${LIMITS.bulletsPerEntry} bullets of a role were kept. Review the original for the rest.`,
            entityId: id,
          });
        }
        return items.slice(0, LIMITS.bulletsPerEntry);
      };
      return {
        id,
        company: company?.text ?? null,
        jobTitle: jobTitle?.text ?? null,
        employmentType: stated(entry.employmentType, EMPLOYMENT_WORDS, region),
        locationType: stated(entry.locationType, LOCATION_WORDS, region),
        startDate: dates.startDate,
        endDate: dates.endDate,
        current: dates.current,
        description: summary ? doc(summary.text) : null,
        achievements: limit(buckets.achievement),
        responsibilities: limit(buckets.responsibility),
        keyContributions: limit(buckets.contribution),
      };
    },
  );

  // education
  anchor = 0;
  const education = capped(output.education, LIMITS.entriesPerSection, 'education').map(
    (entry, index) => {
      const id = `parsed:education:${index}`;
      const at = (field: string, max: number = LIMITS.shortTextChars) => ({
        section: 'education' as const,
        entityId: id,
        field,
        max,
        from: anchor,
      });
      const name = ground(entry.institution, at('name'));
      const degree = ground(entry.degree, { ...at('degreeType'), near: name?.span });
      const next = regionOf([name?.span, degree?.span].filter((span): span is Span => !!span));
      if (next) anchor = next.start;
      if (name) fact('institution', 'education', id, 'name', name.text, name.span);
      if (degree) fact('degree', 'education', id, 'degreeType', degree.text, degree.span);
      const dates = period('education', id, entry.start, entry.end, anchor);
      const details = ground(entry.details, at('description', LIMITS.longTextChars));
      return {
        id,
        name: name?.text ?? null,
        // A degree type is a classification of the quoted degree, so it needs that quote.
        degreeType: degree ? entry.degreeType : null,
        startDate: dates.startDate,
        endDate: dates.endDate,
        current: dates.current,
        description: details ? doc(details.text) : null,
      };
    },
  );

  const titled = (section: 'projects' | 'recommendations') =>
    capped(
      section === 'projects'
        ? output.projects.map((p) => ({ name: p.name, url: p.url, text: p.description }))
        : output.recommendations,
      LIMITS.entriesPerSection,
      section,
    ).map((entry, index) => {
      const id = `parsed:${section}:${index}`;
      const at = (field: string, max: number = LIMITS.shortTextChars) => ({
        section,
        entityId: id,
        field,
        max,
      });
      const name = ground(entry.name, at('name'));
      const link = ground(entry.url, at('url'));
      const body = ground(entry.text, at('description', LIMITS.longTextChars));
      if (name && section === 'projects')
        fact('project', section, id, 'name', name.text, name.span);
      return {
        id,
        name: name?.text ?? null,
        url: link?.text ?? null,
        description: body ? doc(body.text) : null,
      };
    });
  const projects = titled('projects');
  const recommendations = titled('recommendations');

  const named = (section: 'skills' | 'tools', values: string[]) => {
    const seen = new Set<string>();
    const items: { id: string; name: string }[] = [];
    for (const value of values) {
      const id = `parsed:${section}:${items.length}`;
      const found = ground(value, {
        section,
        entityId: id,
        field: 'name',
        max: LIMITS.shortTextChars,
      });
      if (!found || seen.has(found.text.toLowerCase())) continue;
      seen.add(found.text.toLowerCase());
      items.push({ id, name: found.text });
      fact(section === 'skills' ? 'skill' : 'tool', section, id, 'name', found.text, found.span);
    }
    return capped(items, LIMITS.entriesPerSection, section);
  };
  const skills = named('skills', output.skills);
  const tools = named('tools', output.tools);

  const links = capped(
    output.links.flatMap((link, index) => {
      const id = `parsed:links:${index}`;
      const value = ground(link.url, {
        section: 'links',
        entityId: id,
        field: 'value',
        max: LIMITS.shortTextChars,
      });
      if (!value) return [];
      const label = ground(link.label, {
        section: 'links',
        entityId: id,
        field: 'type',
        max: LIMITS.shortTextChars,
      });
      return [{ id, type: label?.text ?? null, value: value.text }];
    }),
    LIMITS.entriesPerSection,
    'links',
  );

  const languages = capped(
    output.languages.flatMap((item, index) => {
      const id = `parsed:languages:${index}`;
      const found = ground(item.language, {
        section: 'languages',
        entityId: id,
        field: 'language',
        max: LIMITS.shortTextChars,
      });
      if (!found) return [];
      fact('language', 'languages', id, 'language', found.text, found.span);
      const statement = text.slice(found.span.start, clauseEnd(text, found.span.end));
      const proficiency =
        item.proficiency && PROFICIENCY_WORDS[item.proficiency]?.test(statement)
          ? item.proficiency
          : null;
      return [{ id, language: found.text, proficiency }];
    }),
    LIMITS.entriesPerSection,
    'languages',
  );

  // Content the model could not place, then content nobody accounted for.
  for (const passage of output.unplaced) {
    const span = source.find(passage);
    if (!span) continue;
    spans.push(span);
    warn({
      code: 'unplaced_text',
      message: 'Some resume text did not fit any field. Review it in the original.',
      page: pageOf(span.start),
    });
  }
  const unaccounted = uncoveredLines(text, spans);
  for (const line of unaccounted.slice(0, UNACCOUNTED_REPORTED)) {
    warn({
      code: 'text_not_accounted',
      message: 'A passage of the resume was not placed in any field. Review it in the original.',
      page: pageOf(line.start),
    });
  }
  if (unaccounted.length > UNACCOUNTED_REPORTED) {
    warn({
      code: 'text_not_accounted',
      message: `${unaccounted.length - UNACCOUNTED_REPORTED} more passages were not placed in any field.`,
    });
  }
  if (factsCut || uncertaintiesCut) {
    complete = false;
    warnings.push({
      code: 'result_limit',
      message: 'This resume has more detail than one result can list. Review the original.',
      entityId: null,
      page: null,
    });
  }

  const career: CareerDocument = {
    person: {
      firstName: firstName?.text ?? null,
      lastName: lastName?.text ?? null,
      role: role?.text ?? null,
      tagline: tagline?.text ?? null,
      // Seniority is a judgment, not something a resume states; it is never inferred here.
      seniority: null,
    },
    contacts: { email: email?.text ?? null, phone: phone?.text ?? null, url: url?.text ?? null },
    location: { city: city?.text ?? null, country: country?.text ?? null },
    experience,
    education,
    projects,
    recommendations,
    skills,
    tools,
    links,
    languages,
  };
  return { career, facts, uncertainties, warnings, complete };
}
