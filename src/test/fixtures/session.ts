import { loadFixture } from '@talvio/llm-contracts/fixtures';
import type { CareerDocument, JobDescription, SourceSnapshot } from '@talvio/llm-contracts';

import type { CareerView } from '../../lib/career/view';
import type { AnalysisOutput } from '../../lib/prompts/analyze-resume';

/*
 * Session fixtures for analysis and questions (MDI-218): a profile with a job description, a
 * sparse profile and one with conflicting facts. Names and companies are invented.
 */

const tailor = loadFixture('valid', 'session-create-tailor-with-jd').payload as {
  source: SourceSnapshot;
  jobDescription: JobDescription;
};

export const TAILOR_SOURCE: SourceSnapshot = tailor.source;
export const JOB: JobDescription = tailor.jobDescription;

const empty: CareerDocument = {
  person: { firstName: null, lastName: null, role: null, tagline: null, seniority: null },
  contacts: { email: null, phone: null, url: null },
  location: { city: null, country: null },
  experience: [],
  education: [],
  projects: [],
  recommendations: [],
  skills: [],
  tools: [],
  links: [],
  languages: [],
};

const snapshot = (document: CareerDocument): SourceSnapshot => ({
  source: { kind: 'profile', id: TAILOR_SOURCE.source.id, revision: '2026-11-01T08:00:00.000Z' },
  document,
});

/** A profile with a title, one undated role and nothing else. */
export const SPARSE_SOURCE = snapshot({
  ...empty,
  person: { ...empty.person, role: 'Data Analyst' },
  experience: [
    {
      id: 'exp-sparse-1',
      company: 'Northwind',
      jobTitle: 'Analyst',
      employmentType: null,
      locationType: null,
      startDate: null,
      endDate: null,
      current: null,
      description: null,
      achievements: [],
      responsibilities: [],
      keyContributions: [],
    },
  ],
});

/** Two roles whose dates overlap while both claim to be the only full-time job. */
export const CONFLICTING_SOURCE = snapshot({
  ...empty,
  person: { ...empty.person, role: 'Engineering Manager' },
  experience: [
    {
      id: 'exp-conflict-1',
      company: 'Contoso',
      jobTitle: 'Engineering Manager',
      employmentType: 'full-time',
      locationType: null,
      startDate: '2020-01',
      endDate: null,
      current: true,
      description: null,
      achievements: ['Managed a team of 12 engineers'],
      responsibilities: [],
      keyContributions: [],
    },
    {
      id: 'exp-conflict-2',
      company: 'Fabrikam',
      jobTitle: 'Staff Engineer',
      employmentType: 'full-time',
      locationType: null,
      startDate: '2019-06',
      endDate: '2022-01',
      current: false,
      description: null,
      achievements: ['Managed a team of 4 engineers'],
      responsibilities: [],
      keyContributions: [],
    },
  ],
});

/** The handle the view gave a field, for building model output in tests. */
export function handle(view: CareerView, entityId: string | null, field: string): string {
  const found = view.fields.find((f) => f.entityId === entityId && f.field === field);
  if (!found) throw new Error(`no field ${entityId ?? '-'}.${field}`);
  return found.handle;
}

const ACME = '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f51';
const GO = '4a5b6c7d-8e9f-4a0b-9c2d-3e4f5a6b7c84';

/** What a well-behaved model returns for the tailoring fixture. */
export function analysisOutput(view: CareerView): AnalysisOutput {
  return {
    requirements: [
      { quote: '5+ years building backend services in Go', kind: 'required' },
      { quote: 'experience with PostgreSQL at scale', kind: 'required' },
      { quote: 'Kafka or another event streaming platform', kind: 'preferred' },
      { quote: 'experience leading a small team', kind: 'preferred' },
    ],
    coverage: [
      {
        requirement: 0,
        status: 'partial',
        evidence: [{ ref: handle(view, GO, 'name'), quote: 'Go' }],
        note: 'Go is listed, but the years using it are not.',
      },
      {
        requirement: 1,
        status: 'partial',
        evidence: [{ ref: handle(view, 'legacy:skills:1', 'name'), quote: null }],
        note: null,
      },
      {
        requirement: 2,
        status: 'supported',
        evidence: [{ ref: handle(view, 'legacy:tools:0', 'name'), quote: 'Kafka' }],
        note: null,
      },
      {
        requirement: 3,
        status: 'supported',
        evidence: [
          { ref: handle(view, ACME, 'description'), quote: 'Led the payments platform team' },
        ],
        note: null,
      },
    ],
    findings: [
      {
        severity: 'medium',
        category: 'impact',
        section: 'experience',
        entityId: '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a62',
        message: 'The Globex role lists a duty but no result.',
        evidence: [
          {
            ref: handle(view, '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a62', 'responsibilities.0'),
            quote: 'Maintained billing jobs',
          },
        ],
        requirement: null,
      },
      {
        severity: 'high',
        category: 'job_match',
        section: 'experience',
        entityId: null,
        message: 'The job asks for 5+ years of Go; the profile does not say how long Go was used.',
        evidence: [{ ref: handle(view, GO, 'name'), quote: 'Go' }],
        requirement: 0,
      },
    ],
  };
}
