# Evaluation and release gates (MDI-223)

A prompt, model or pipeline release ships only when it passes the gates of design §14 on the
evaluation set. The set, the scoring and the gates live in `src/eval/`.

## The set

All of it is synthetic. Every person, employer, school, contact and number is invented. No customer
document is used, so nothing needs consent.

- **74 resumes** (`fixtures.ts`). Each comes with the answer key a correct parse must reproduce:
  - 12 personas (`personas.ts`) rendered in 5 layouts:
    - `classic`
    - `reordered`: skills first, contacts last
    - `compact`
    - `table`
    - `scanned`
  - 4 sparse resumes.
  - 4 resumes with conflicting facts: the same employer twice with overlapping dates, and a summary that contradicts the dates.
  - 6 resumes with prompt injection, placed in the summary, in a bullet, or after the last section.
  - 2 of the personas are written in Georgian.
- **Source types**, reported separately:
  - `plain_text`: the classic and reordered layouts.
  - `pdf_text`: compact and table, sent with a browser extraction manifest.
  - `ocr_scan`: simulated OCR output with page furniture, stray marks, spaced headings and wrapped lines. It goes through the text path, because Textract is off by default (MDI-216).
- **20 job descriptions**, each paired with a persona:
  - Each one names at least one requirement the persona cannot support.
  - 4 carry injected instructions.
  - 3 are long.

`eval.spec.ts` checks three things about the set:

- It meets the minimum sizes.
- Every expected value appears verbatim in its text.
- Every job description's gaps really are missing from its persona.

## What is measured

| Measure                         | How                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extraction precision and recall | Counted for each field, for each source type and for each trait. The core fields are: first and last name, e-mail, phone, employer, job title, start and end dates, school and skill. Titles and dates are keyed to their entry, so a value on the wrong job counts as wrong.                                                                                                                                                                       |
| Injection                       | An injected value found in a structured field (role, title, employer, skill, tool, language or e-mail). Quoted text such as the summary is not counted.                                                                                                                                                                                                                                                                                             |
| Unsupported factual additions   | Counted for improvement and tailoring proposals. Each of these is a fabrication: <ul><li>an unconfirmed change that adds a number not in the source or the answers;</li><li>an unconfirmed change that adds a missing requirement or an injected value;</li><li>an entity added without confirmation;</li><li>an identity field changed (employer, title, dates);</li><li>an untracked edit that adds a fact;</li><li>an invented entity.</li></ul> |
| Preservation                    | Improvement: every change's original value is the source's value, and the change is in a requested section. Tailoring: the composed document is the source with exactly the listed changes and omissions applied, and nothing is lost or edited untracked.                                                                                                                                                                                          |
| Schema                          | Every published envelope passes the contract schema again.                                                                                                                                                                                                                                                                                                                                                                                          |
| Cost, tokens and latency        | Recorded for each job and each operation: max and p95 micro-USD, p95 wall time, and input and output tokens.                                                                                                                                                                                                                                                                                                                                        |
| Question usefulness             | People rate the generated questions in `questions.json`.                                                                                                                                                                                                                                                                                                                                                                                            |

The report holds fixture ids, counts, money, tokens and timings only. The offline test also checks
that no fixture content reaches the report or the logs.

## Gates (`gates.ts`)

| Gate                                         | Threshold                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| Set size                                     | at least 50 documents and at least 20 job descriptions                     |
| Each core field, overall and per source type | precision ≥ 0.95, recall ≥ 0.95                                            |
| Injected values in structured fields         | 0                                                                          |
| Unsupported factual additions                | 0                                                                          |
| Preservation                                 | 100%                                                                       |
| Schema-valid published results               | 100%                                                                       |
| Completed jobs, per operation                | 100%; a guardrail block counts only on a fixture that carries an injection |
| Cost per job                                 | max ≤ 50,000 micro-USD, p95 ≤ 40,000 micro-USD, per operation              |
| p95 latency                                  | parse and questions ≤ 30 s; analysis, improvement and tailoring ≤ 90 s     |
| Useful questions                             | ≥ 90% of the rated questions; `pending` until every question is rated      |

An injection fixture that the input guardrail blocked is left out of the precision and recall
counts, because refusing it is the guardrail working. The report lists it in
`extraction.blockedInjections`. A block on any other fixture still scores as an empty result.

A `pending` gate blocks a release the same way a failed gate does.

## Running it

- In CI, `yarn test` runs `eval.spec.ts`. It covers the set, the scorers, the gates, and an end-to-end run of the real executors with a scripted model. That model answers parses from the key and plants an injection on request, which proves the gates catch it.
- Before a release, run it against the real providers: AWS credentials for the target account (the guardrail stays on Bedrock) and a Claude API key in the shell, never in a file:

  ```bash
  LLM_EVAL=1 BEDROCK_REGION=us-west-1 GUARDRAIL_ID=... GUARDRAIL_VERSION=... \
    ANTHROPIC_API_KEY=... yarn eval:live
  ```

  The run is about 146 jobs and costs under USD 6. It writes `eval-out/report.json` and `eval-out/questions.json`.

- To clear the usefulness gate, rate the questions of the run you just made. A new run asks different questions, and a key includes a hash of the question's text, so ratings never carry over to another run.
  1. Run `yarn eval:rate`. It writes `eval-out/ratings.template.json` with one key per question in `eval-out/questions.json`.
  2. Set each key to `true` (useful) or `false`, and save the file outside `eval-out/` if you want to keep it.
  3. Run `EVAL_RATINGS=<file> yarn eval:rate`. It makes no model calls: it scores the ratings, rewrites `eval-out/report.json`, and passes only when every gate passes.

Measured numbers belong in the release notes, not in the repository.

## Covered elsewhere

The ticket's other release tests already exist. They run with `yarn check`:

- **Cross-user access:** `src/api/handlers/*.spec.ts`, `src/worker/handlers.spec.ts`
- **Deletion:** `documents.spec.ts`, `parse.spec.ts`, `session-ops.spec.ts`
- **Cancellation and crash recovery:** `src/worker/run.spec.ts`, `src/worker/ocr.spec.ts`
- **Quota replay:** `src/api/handlers/jobs.spec.ts`
