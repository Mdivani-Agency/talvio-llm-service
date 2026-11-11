import type { ModelOutput } from '../../lib/prompts/parse-document';

/** A short resume and what a well-behaved model returns for it. Names and contacts are invented. */
export const RESUME = `Nino Beridze
Senior Backend Engineer
nino.beridze@example.com | +995 555 000 000 | Tbilisi, Georgia

EXPERIENCE
Acme Payments — Senior Backend Engineer (Remote, Full-time)
Mar 2021 – Present
- Cut settlement latency by 40% by redesigning the ledger service
- Own the on-call rotation for the payments API

Globex — Backend Engineer
2018 – 2021
- Built the billing export used by 300 customers

EDUCATION
Tbilisi State University — BSc Computer Science
2014 – 2018

SKILLS
TypeScript, PostgreSQL, AWS

LANGUAGES
Georgian (native), English (fluent)`;

export const modelOutput = (overrides: Partial<ModelOutput> = {}): ModelOutput => ({
  person: {
    firstName: 'Nino',
    lastName: 'Beridze',
    role: 'Senior Backend Engineer',
    tagline: null,
  },
  contacts: { email: 'nino.beridze@example.com', phone: '+995 555 000 000', url: null },
  location: { city: 'Tbilisi', country: 'Georgia' },
  experience: [
    {
      company: 'Acme Payments',
      jobTitle: 'Senior Backend Engineer',
      employmentType: 'full-time',
      locationType: 'remote',
      start: 'Mar 2021',
      end: 'Present',
      summary: null,
      bullets: [
        {
          text: 'Cut settlement latency by 40% by redesigning the ledger service',
          kind: 'achievement',
        },
        { text: 'Own the on-call rotation for the payments API', kind: 'responsibility' },
      ],
    },
    {
      company: 'Globex',
      jobTitle: 'Backend Engineer',
      employmentType: null,
      locationType: null,
      start: '2018',
      end: '2021',
      summary: null,
      bullets: [{ text: 'Built the billing export used by 300 customers', kind: 'contribution' }],
    },
  ],
  education: [
    {
      institution: 'Tbilisi State University',
      degree: 'BSc Computer Science',
      degreeType: "Bachelor's Degree",
      start: '2014',
      end: '2018',
      details: null,
    },
  ],
  projects: [],
  recommendations: [],
  skills: ['TypeScript', 'PostgreSQL', 'AWS'],
  tools: [],
  links: [],
  languages: [
    { language: 'Georgian', proficiency: 'native' },
    { language: 'English', proficiency: 'fluent' },
  ],
  unplaced: [],
  ...overrides,
});
