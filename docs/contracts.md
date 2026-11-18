# LLM service contracts (`@talvio/llm-contracts`)

The contract between talvio-web-app and talvio-llm-service: what the web sends, what the service returns and what the web saves when a user accepts a proposal. The system design is the [Talvio LLM orchestration service — system design](https://app.notion.com/p/3daf87a6db5781eb93d5e25326f24619) page (§§2–6, 12). This package implements it as code ([MDI-211](https://linear.app/mdivani/issue/MDI-211)).

## Package

`packages/contracts` is a Yarn workspace in this repository.

| Path                                 | Contents                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`                               | Zod 4 schemas, inferred TypeScript types and small pure helpers (`applyTargetFor`, `checkApplySelection`, `canonicalJson`, `legacyAccountToCareer`) |
| `generated/openapi.json`             | OpenAPI 3.1 document for `/llm/v1`, generated from the schemas                                                                                      |
| `generated/schemas/*.json`           | Standalone JSON Schema (draft 2020-12) for each top-level request and response                                                                      |
| `fixtures/valid`, `fixtures/invalid` | Payloads that must parse or must be rejected                                                                                                        |
| `fixtures/legacy`                    | Payloads the current web AI routes exchange today                                                                                                   |

```bash
cd packages/contracts
yarn test        # fixtures, invariants, JSON Schema cross-check, generated files up to date
yarn typecheck
yarn generate    # rebuild generated/ after changing a schema; commit the result
```

The schemas are the source of truth. `generated/` is derived from them and checked by `test/generated.spec.ts`, so a schema change without `yarn generate` fails the tests. JSON Schema cannot express the cross-field rules (for example "a succeeded job has a result"). Those run only in the Zod validators, so JSON Schema consumers accept slightly more than the service does.

**How talvio-web-app uses it (decided 12 Oct 2026):** the web treats this service like any third-party API. It implements its own client from this document, `generated/openapi.json` and `generated/schemas/*.json`. There is no shared package dependency and no copy script, which is why this document is the authoritative description. Publishing the package to npm is deferred to [MDI-439](https://linear.app/mdivani/issue/MDI-439).

## Shape of the API

Base path `https://api.<stage>.talvio.co/llm/v1`. Browsers call the same-origin `/api/llm` adapter, which forwards the Supabase access token. The routes are in `generated/openapi.json`.

- **Documents:** `POST /documents` → upload grant; `POST /documents/{id}/complete` → validation (no OCR or model); `GET`/`DELETE /documents/{id}`.
- **Sessions:** `POST /sessions` binds one improve or tailor journey to a source snapshot and an optional job description. `POST /sessions/{id}/contexts` and `POST /sessions/{id}/answers` each create a new immutable context revision.
- **Jobs:** `POST /jobs` (header `Idempotency-Key`, equal to `clientRequestId`) → `202 JobAccepted`; poll `GET /jobs/{id}`; `POST /jobs/{id}/cancel|retry`; `GET /jobs?cursor=`.

| Operation            | Input                                                                                    | Result                                                                                  | Session |
| -------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------- |
| `parse_document`     | Pasted or browser-extracted text with an optional page manifest, or a ready `documentId` | Partial `CareerDocument`, fact ledger with evidence, uncertainties, extraction coverage | No      |
| `analyze_resume`     | Sections                                                                                 | Findings, JD requirements, requirement-coverage matrix, priorities                      | Yes     |
| `generate_questions` | Round, max questions, optional analysis job                                              | Question set: 0–5 questions with stable ids, topic keys, reasons                        | Yes     |
| `improve_profile`    | Sections, optional target role                                                           | Proposal applied to the profile                                                         | Yes     |
| `improve_resume`     | Sections, optional target role                                                           | Proposal applied to the resume or its draft family                                      | Yes     |
| `tailor_resume`      | New resume name                                                                          | Proposal for a new JOB_SPECIFIC resume, requirement coverage, unsupported requirements  | Yes     |

Every result comes in an envelope with `jobId`, `schemaVersion`, `inputHash`, `contextRevisionId`/`contextHash`, `sourceRevision`, pipeline/prompt/model versions, `resultKind` (`complete` or `partial`) and `warnings`. The web compares these bindings with its current state to detect stale results.

## Rules the schemas enforce

- **Typed JSON only.** A result is an object, never JSON encoded inside a string (today's `/api/resume/parse` does that). Unknown fields are rejected everywhere, so a client cannot pick a model or override a policy.
- **Stable identity.** Entities, questions, facts, changes and requirements have stable ids. Persisted entities keep their row UUID; new ones use prefixed keys (`parsed:experience:0`). Answers and proposal changes refer to ids, never positions.
- **No guessed facts.** Dates are partial dates (`2021`, `2021-03`, `2021-03-15`) or `null`. `current` is `true` only when the source says so; a missing end date leaves it `null`.
- **Rich text** uses a compact AST (`paragraph`, `bulletList`, `orderedList`; `bold`, `italic`, `underline`; https links only), not TipTap JSON. The web converts in both directions.
- **Proposals change named fields only.** `TARGETABLE_FIELDS` lists them. Contacts, dates, employers and titles are never targets. Each change carries its original value as a precondition, its evidence and the claims the user must confirm. Omissions list every removed fact; a rejected omission keeps the original.
- **Limits** (`LIMITS`): 10 MB upload, 30 PDF pages, 3 OCR pages, 100,000 source characters, 5,000 job description characters, 5 questions per set, 10 per session, 2 rounds, 2 active jobs and 20 jobs per user per UTC day, 10-minute job deadline.

## Generated resumes, drafts and job variants

`applyTargetFor(operation, source)` is the only mapping from a source to where an accepted proposal is saved. A result with any other `applyTarget` is invalid.

| Operation         | Source           | Apply target                                                                                                                                                              |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `improve_profile` | profile          | `profile`; `baseRevision` is recorded but not enforced in v1 (last-write-wins)                                                                                            |
| `improve_resume`  | draft resume     | `resume_draft` at `baseRevision`                                                                                                                                          |
| `improve_resume`  | generated resume | `resume_draft_family`: save into the generated resume's one open draft; the generated row is never modified                                                               |
| `tailor_resume`   | any              | `new_resume` with `resumeType: job_specific` and `derivedFrom`; not part of the source's draft family (`source_resume_id` stays reserved for drafts of generated resumes) |

The apply request and receipt (`applyRequestSchema`, `applyReceiptSchema`) are executed by the web in its own transaction ([MDI-222](https://linear.app/mdivani/issue/MDI-222)). `checkApplySelection` rejects a selection that names unknown changes or omissions, misses a required claim confirmation, targets something else, or creates a resume without a stable `clientDraftId`. PDF generation and credits are untouched: no operation renders a PDF or debits credits.

## Current web routes and their replacements

Mapped against talvio-web-app `development` @ `6ced44c` (the design's review commit `083ccee` is older; XState is gone and Improve with AI lives in the resume editor since then). `LEGACY_ROUTES` holds the same table in code.

| Route today                                                                    | Callers                                                   | Replacement                          | What changes                                                                                                       |
| ------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `POST /api/resume/parse` `{resume}` → ParsedAccount as a JSON string           | `hooks/use-resume-parser.ts` (onboarding and import page) | `parse_document`                     | Typed result with evidence, uncertainties and coverage; never double-encoded. Guessed `isPresent` dates disappear. |
| `POST /api/resume/qa` `{resume}` → `{questions: [{question, example}]}`        | `app/resume/hooks/use-ai-improve.ts`                      | session + `generate_questions`       | Server-issued question ids, topic keys and reasons; answers keyed by id                                            |
| `POST /api/resume/account` `{account, questions[], answers[]}` → whole account | `app/resume/hooks/use-ai-improve.ts`                      | `improve_resume` / `improve_profile` | Field-level changes with preconditions replace position matching in `applyAiProposal`                              |
| `POST /api/resume/complete`                                                    | none in the UI (e2e access/cap specs only)                | none                                 | Retire; job-specific drafting is `tailor_resume`                                                                   |

`legacyAccountToCareer` converts today's account-shaped payload (`documentToAiPayload`, parse output) into a `CareerDocument`, and `fixtures/legacy` pins those payloads. Together they show the current flow fits the contract and give MDI-221 a starting adapter.

## Versioning and compatibility

- Every request and result carries `schemaVersion` (`1.0`). The service accepts every minor version of its major version (`SUPPORTED_SCHEMA_VERSIONS`).
- **Minor version (1.x):** optional request fields, new operations, new result fields or enum members that clients can ignore. Clients must tolerate unknown result fields and enum members. The service must keep accepting requests from older minors.
- **Major version (2.0):** anything else: removing or renaming a field, tightening a limit, changing a meaning. It gets a new base path (`/llm/v2`); `/llm/v1` stays until no web build uses it.
- Results are pinned: a job keeps the schema, prompt and pipeline versions it was admitted with, and `versions` reports them.

## Rollout ownership

| Change                                          | Owner                                                                                                                     | Order                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Schemas, fixtures, generated OpenAPI            | talvio-llm-service (`packages/contracts`)                                                                                 | First, reviewed with both repos in mind |
| Service accepting a new minor                   | talvio-llm-service                                                                                                        | Deployed before any web build sends it  |
| Web adapters, `/api/llm` proxy, review/apply UI | talvio-web-app ([MDI-221](https://linear.app/mdivani/issue/MDI-221), [MDI-222](https://linear.app/mdivani/issue/MDI-222)) | After the service accepts the version   |
| Apply transaction, receipts, provenance tables  | talvio-web-app (Supabase migrations)                                                                                      | With MDI-214/MDI-222                    |
| Removing legacy routes and the OpenAI SDK       | talvio-web-app ([MDI-224](https://linear.app/mdivani/issue/MDI-224))                                                      | After parity on the new routes          |

A breaking change ships as a new major path next to the old one, never in place.

## Service boundary

Decided 12 Oct 2026 ([MDI-181](https://linear.app/mdivani/issue/MDI-181)):

- **Self-contained data.** The service keeps all of its state in its own DynamoDB tables and private S3 buckets, which Terraform owns. It never reads or writes the web app's Supabase database.
- **Authorization from token claims.** An API Gateway authorizer verifies the Supabase access token and requires `account_status: active` and a known `plan`; a custom-access-token hook in talvio-web-app adds both claims ([MDI-440](https://linear.app/mdivani/issue/MDI-440)). Tokens live 15 minutes, so a suspended account or a plan change takes effect within one token lifetime. A refused token gets `401 unauthorized` (with "AI features are not available for this account." when the token is valid but the account or plan is not) and an authorizer failure gets `503 dependency_unavailable`, both in the usual error body. A new plan must be added to the service before the web issues it.
- **Per-user limits by plan.** AI limits are resolved per user from `plan` plus overrides and enforced by the service's own quota store. They replace the web's `ai_daily_usage` cap at cutover.
- **Deletion by retention.** There is no account-deletion call. Service data ages out through TTL and lifecycle rules: 24 h for incomplete uploads, 7 days for files and for every result payload (accepted or not), 30 days for content-free job metadata. The service is never told that a proposal was accepted: the web copies accepted content and its provenance into its own tables when it applies it, so a result's expiry never loses accepted content.
- **Apply stays in the web.** Accepted proposals are saved by a Postgres function in the web app, atomically with the apply receipt ([MDI-222](https://linear.app/mdivani/issue/MDI-222)).

## Known gaps

- **No profile concurrency check in v1 (accepted).** `save_profile` is an unconditional upsert and profiles have no revision token. The web sends the profile's `updated_at` as `revision`, but applying a profile proposal is last-write-wins and can overwrite a concurrent edit. Resumes are revision-checked.
- **Web contract tests** run against the web app's own client, using the fixtures in `fixtures/` as reference payloads.
- **Language, guardrail and OCR behavior** are represented only as error codes and warnings. Their policies arrive with MDI-216/MDI-217.
