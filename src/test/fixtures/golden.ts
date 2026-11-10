import { RESUME } from './parse';

/*
 * Golden set for parse_document cost and grounding (MDI-217). Synthetic resumes, no real people:
 * a typical one, a long one at the edge of typical length, and a non-Latin one. MDI-223 owns the
 * full evaluation set and its quality gates; this set exists to measure metered cost against the
 * USD 0.04 p95 target and the USD 0.05 cap before a model or prompt version ships.
 */

const role = (n: number) => `Company ${n} Ltd — Software Engineer
Jan ${2000 + n} – Dec ${2001 + n}
- Delivered project ${n} for a logistics client, reducing processing time by ${10 + n}%
- Maintained the reporting service and its nightly jobs
- Mentored two junior engineers and reviewed their code weekly
`;

export const GOLDEN: { name: string; text: string }[] = [
  { name: 'typical', text: RESUME },
  {
    name: 'long',
    text: `Giorgi Example\nPrincipal Engineer\ngiorgi@example.com\n\nEXPERIENCE\n${Array.from({ length: 12 }, (_, i) => role(i + 1)).join('\n')}\nSKILLS\nTypeScript, Go, PostgreSQL, Kafka, AWS, Terraform`,
  },
  {
    name: 'georgian',
    text: `ნინო ბერიძე
პროგრამისტი
nino@example.com

გამოცდილება
შპს „მაგალითი“ — უფროსი პროგრამისტი
2020 – დღემდე
- გადახდების სერვისის შექმნა და მხარდაჭერა

განათლება
თბილისის სახელმწიფო უნივერსიტეტი — კომპიუტერული მეცნიერება
2014 – 2018`,
  },
];
