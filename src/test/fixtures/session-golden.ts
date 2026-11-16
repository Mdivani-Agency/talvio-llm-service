import type { CareerDocument, JobDescription, SourceSnapshot } from '@talvio/llm-contracts';

import { CONFLICTING_SOURCE, JOB, SPARSE_SOURCE, TAILOR_SOURCE } from './session';

/*
 * Golden set for analyze_resume and generate_questions cost (MDI-218): the tailoring profile with
 * its job description, a sparse and a conflicting profile without one, and a long profile with a
 * job description at the 5,000-character limit. Synthetic, no real people. MDI-223 owns the full
 * evaluation set; this one measures cost against the USD 0.04 p95 target and the USD 0.05 cap.
 */

const longDocument = (): CareerDocument => {
  const base = TAILOR_SOURCE.document;
  return {
    ...base,
    person: {
      ...base.person,
      tagline:
        'Backend engineer with a decade of payments, billing and data platform work across startups and enterprises.',
    },
    experience: Array.from({ length: 12 }, (_, n) => ({
      id: `exp-long-${n}`,
      company: `Company ${n} Ltd`,
      jobTitle: n % 3 === 0 ? 'Senior Software Engineer' : 'Software Engineer',
      employmentType: 'full-time' as const,
      locationType: null,
      startDate: `${2005 + n}-01`,
      endDate: `${2006 + n}-12`,
      current: false,
      description: null,
      achievements: [
        `Delivered project ${n} for a logistics client, reducing processing time by ${10 + n}%`,
        `Migrated service ${n} to a managed database with no customer-facing downtime`,
      ],
      responsibilities: [
        'Maintained the reporting service and its nightly jobs',
        'Reviewed code for two teams and kept the on-call runbooks current',
      ],
      keyContributions: ['Mentored two junior engineers and reviewed their code weekly'],
    })),
    skills: Array.from({ length: 25 }, (_, n) => ({ id: `skill-long-${n}`, name: `Skill ${n}` })),
  };
};

const longJob: JobDescription = {
  ...JOB,
  text: `${JOB.text} ${'Responsibilities include designing, building and operating backend services for payments, reviewing code and mentoring engineers. '.repeat(40)}`.slice(
    0,
    5_000,
  ),
};

export const SESSION_GOLDEN: {
  name: string;
  source: SourceSnapshot;
  jobDescription: JobDescription | null;
}[] = [
  { name: 'tailor', source: TAILOR_SOURCE, jobDescription: JOB },
  { name: 'sparse', source: SPARSE_SOURCE, jobDescription: null },
  { name: 'conflicting', source: CONFLICTING_SOURCE, jobDescription: null },
  { name: 'long', source: { ...TAILOR_SOURCE, document: longDocument() }, jobDescription: longJob },
];
