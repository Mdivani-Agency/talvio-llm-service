# Talvio LLM service

Talvio's AI orchestration service: an authenticated async job API at `https://api.<stage>.talvio.co/llm/v1` for parsing documents, analysing and improving profiles and resumes, gap questions and job-specific resumes. Design: [Talvio LLM orchestration service — system design](https://app.notion.com/p/3daf87a6db5781eb93d5e25326f24619) (epic [MDI-181](https://linear.app/mdivani/issue/MDI-181)).

**Status:** API boundary only ([MDI-212](https://linear.app/mdivani/issue/MDI-212)). Authentication, routing, request validation and idempotency checks run. No store, queue or model is wired yet, so every route except health answers `503 dependency_unavailable` on deployed stages. Persistence arrives with MDI-214 (DynamoDB, Terraform-owned), execution with MDI-215, and models with MDI-217. The service is self-contained: its data lives in its own AWS resources, and it shares nothing with the web app's database except the identity in the access token.

## Layout

| Path                                  | Contents                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts`                  | `@talvio/llm-contracts`: request/result schemas, OpenAPI, fixtures ([docs/contracts.md](docs/contracts.md))                                      |
| `src/handler.ts`                      | Lambda entry; validates configuration once per container                                                                                         |
| `src/api/route-table.ts`              | Every route; `serverless.ts` creates one API Gateway event per entry                                                                             |
| `src/api/app.ts`                      | Request pipeline: correlation id, authentication, active-account check, body parsing, safe errors, logging                                       |
| `src/api/handlers/`                   | Documents, sessions and jobs                                                                                                                     |
| `src/lib/auth.ts`                     | Supabase JWT verification                                                                                                                        |
| `src/lib/store/`                      | Owner-scoped store interfaces; `dynamo/` (deployed), `memory` (local/test) and `unconfigured` implementations; `limits.ts` holds per-plan limits |
| `src/lib/config.ts`, `src/lib/log.ts` | Configuration validation and content-free logging                                                                                                |

## Commands

```bash
yarn install            # Node 22, Yarn 4 (corepack enable)
yarn lint
yarn typecheck
yarn test               # service tests
yarn test:contracts     # contract package tests
yarn check              # all of the above
yarn smoke:bedrock      # opt-in: real Bedrock smoke test and golden-set cost run (see below)
yarn start              # serverless-offline on :3005 with the memory store (needs .env, see .env.example)
```

## Requests and security

- **Callers.** Browsers call the web app's same-origin `/api/llm` adapter, which forwards the user's Supabase access token. The service sends no CORS headers.
- **Authorizer.** Every route except `GET /v1/health` goes through an API Gateway TOKEN authorizer (`src/authorizer.ts`, logic in `src/api/authorizer.ts`). It verifies the token against the project's JWKS: signature, issuer `${SUPABASE_URL}/auth/v1`, audience `authenticated`, asymmetric algorithm only (`ES256`/`RS256`), `exp`, a UUID `sub` and `role: authenticated`. Anonymous users are refused, and `user_metadata` is never read. Rotated keys are picked up from JWKS without a deploy.
- **Account status and plan.** The authorizer then requires the `account_status: active` and `plan` claims, which talvio-web-app's custom access-token hook adds ([MDI-440](https://linear.app/mdivani/issue/MDI-440)). `plan` must be listed in `src/lib/plans.ts` (today only `free`). Access tokens live 15 minutes, so a suspension or plan change takes effect within one token lifetime. The service never queries Supabase.
- **Refusals.** API Gateway answers refusals in the contract's error shape (`src/api/gateway-responses.ts`): a missing or invalid token is `401 unauthorized`; a suspended account, a missing claim or an unknown plan is `401 unauthorized` with "AI features are not available for this account."; an authorizer failure (JWKS unreachable, bad configuration) is `503 dependency_unavailable`. Authorizer results are not cached, and each Allow policy covers only the called method.
- **Ownership.** Handlers get `userId`, `sessionId` and `plan` from the authorizer context and refuse a request without one. Every store call is scoped by owner; another user's job, session or document is a 404.
- **Admission checks.** `POST /v1/jobs` requires an `Idempotency-Key` header equal to `clientRequestId`. A replay of the same request returns the original job; the same key with a different body returns 409. Requests are validated with the contract schemas, and validation errors list field paths, never values.
- **Logging.** Logs are JSON lines with a fixed set of content-free fields (correlation id, route, status, duration, a hashed user reference, error code). Tokens, bodies, document text and error messages from unknown failures are never logged.
- **Permissions.** Each function runs under a Terraform-owned role read from SSM `/<stage>/llm/<role>-role-arn` ([MDI-213](https://linear.app/mdivani/issue/MDI-213), talvio-terraform-iac `modules/llm`). The API role reaches only this service's tables, `pending/` upload prefix, work queues and `bedrock:CountTokens`, and is explicitly denied model invocation, guardrails and Textract. The authorizer role has logs only. The worker, dispatcher and reconciler roles exist already and attach when those functions are added. This stack creates no IAM roles, tables, buckets or queues.

## Stages and configuration

| Variable                                                                          | Source                                                      | Notes                                                                                                                   |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `STAGE`                                                                           | `--stage`                                                   | `local`, `test`, `dev`, `prod`                                                                                          |
| `SUPABASE_URL`                                                                    | SSM `/<stage>/supabase/url` (local: shell/.env)             | https outside local/test                                                                                                |
| `STORE_DRIVER`                                                                    | `serverless.ts` per stage                                   | `dynamodb` on dev/prod; `memory` only on local/test; `unconfigured` answers 503                                         |
| `LLM_{JOBS,SESSIONS,QUOTAS,OUTBOX}_TABLE`                                         | SSM `/<stage>/dynamodb/llm-*` (dev/prod)                    | Terraform-owned tables; required by the `dynamodb` driver                                                               |
| `PIPELINE_RELEASE`                                                                | `serverless.ts` (`v1`)                                      | release new jobs are pinned to; its queue, DLQ and executors finish them                                                |
| `WORK_QUEUE_URLS`                                                                 | SSM `/<stage>/llm/work-queue-url-<release>`                 | JSON map release to URL; required by the `dynamodb` driver on dev/prod                                                  |
| `LLM_{QUARANTINE,ARTIFACTS}_BUCKET`                                               | SSM `/<stage>/s3/llm-*` (dev/prod)                          | Terraform-owned private buckets; required on deployed stages                                                            |
| `OCR_CONTENT_TYPES`, `OCR_TOPIC_ARN`, `OCR_ROLE_ARN`                              | unset by default                                            | content types read by Textract; empty means nothing is ever sent to Textract                                            |
| `BEDROCK_REGION`, `GUARDRAIL_ID`, `GUARDRAIL_VERSION`                             | SSM `/<stage>/llm/bedrock-region`, `guardrail-{id,version}` | source Region of the US inference profile and the pinned input guardrail; without the guardrail no model operation runs |
| `ACCOUNT_DAILY_CEILING_MICRO_USD`                                                 | default `5000000` (USD 5)                                   | account-wide spend per UTC day; change per stage without a code change                                                  |
| `SUPABASE_JWT_AUDIENCE`, `SUPABASE_JWT_ALGORITHMS`, `MAX_BODY_BYTES`, `LOG_LEVEL` | defaults                                                    | see `src/lib/config.ts`                                                                                                 |

An invalid configuration makes every route, health included, answer 503, and the log names only the variables that failed.

## Deploy

The API is served at `api.<domain>/llm` through a base path mapping on the shared custom domain. This stack does not create the domain or its DNS record. CI runs on every pull request; deploying to dev is a manual `workflow_dispatch` with `deploy: true`. It assumes the `AWS_DEPLOY_ROLE_ARN` variable on the `dev` (or `prod`) GitHub Environment, set to the `llm_deploy_role_arn` output of talvio-terraform-iac's main root (also SSM `/<stage>/ci/llm-deploy-role-arn`), and a Serverless Framework 4 access or license key. That role trusts only this repository's `environment:<stage>` OIDC subject, so a dev job cannot assume the prod role. Apply the Terraform platform for the stage first: the stack reads `/<stage>/llm/*` from SSM and fails fast if it is missing.

## State, quotas and retention (MDI-214)

All state is in the four Terraform-owned DynamoDB tables (`src/lib/store/dynamo/db.ts` documents the key layout). Every key starts with the owner, every read and write is owner-scoped, and no access pattern scans.

- **Admission** is one `TransactWriteItems`: the job, its idempotency record, the quota and spend holds (user day, user active, account day) and the outbox event. A replay is answered before any of that and consumes no quota. Transactions are never held across model or OCR calls.
- **Limits** come from `src/lib/limits.ts` (20 jobs per UTC day, 2 active, USD 1.00 per day, USD 0.05 per job, planning budget USD 0.10, account ceiling) by the token's `plan`, and a per-user override item (`U#<user>` / `LIMITS` in the quotas table, any subset of the fields) changes them without a deploy.
- **Retention** is DynamoDB TTL on `expiresAt`: incomplete uploads 24 h, result payloads, sessions, documents and answers 7 days, job metadata, idempotency records and outbox events 30 days. TTL deletion can lag, so reads also treat an expired item as missing.
- **Outbox** events sit in a sparse index until the dispatcher marks them dispatched (see below).

Tests: the same contract suite (`src/lib/store/store.contract.ts`) runs on the memory store and, when `TEST_DYNAMODB_ENDPOINT` is set, on DynamoDB Local. CI starts DynamoDB Local as a service container; locally, point the variable at any DynamoDB Local (`http://localhost:8000`).

## Durable execution (MDI-215)

A job runs on a Terraform-owned standard SQS queue per pipeline release. Messages are content-free (`{v, type, ownerId, jobId, eventId}`); the job record is the source of truth, so a message is only a prompt to look at it.

- **Enqueue.** `POST /v1/jobs` sends the admission event right after the commit. If that fails the job is still accepted and the **dispatcher** (scheduled) sends it from the outbox. A lost ack or a duplicate send is harmless.
- **Lease and fence.** A worker claims a job with a lease (6 min, longer than the 5 min Lambda timeout) and a fence number that every claim and handoff increments. Every write (checkpoint, retry, wait, result) is conditional on `status = running` and the worker's fence, so a worker whose lease expired, or whose job was cancelled or deleted, cannot publish. Repeating a terminal write with the same lease answers `applied` once and changes nothing.
- **Retries.** Max 3 attempts per step with jittered exponential backoff. A retry is parked as a delayed outbox event (`availableAt`), so no Lambda sleeps. A transient error retries; a permanent error fails the job; unknown errors count as transient and log only the error name. The job deadline (10 min from admission) bounds everything. An owner retry of a retryable failure keeps the job's identity and config and resets the attempts; edited input is a new job.
- **Waiting.** `waiting_external` parks a job on an external reference (OCR) with no worker held; `resume` continues it from the completion consumer.
- **Reconciler** (scheduled). Reads a sparse sweep index (never scans) for live jobs whose next check is due: it republishes work whose event was lost, reclaims expired leases, expires jobs past their deadline and resolves DLQ leftovers. It honours ownership, deletion, deadline and budget like any worker.
- **Settlement.** Reservations settle exactly once on any terminal state; actual spend is kept (up to the job cap) and the rest is released. Model calls may repeat after an ambiguous failure; publication and quotas are idempotent.
- **Queue settings.** Batch size 1 with partial-batch-failure reporting, bounded `maximumConcurrency`, visibility timeout 6x the Lambda timeout, receive limit then DLQ. The DLQ handler marks the job failed with a retryable `internal_error`.

Not built yet: executors per operation (a claimed job currently fails with retryable `dependency_unavailable`), the OCR completion consumer, and per-invocation usage settlement; they arrive with the extraction and model tickets.

## Documents and extraction (MDI-216)

Plain text needs no upload: it is submitted as `{kind: 'text'}` (PDF text extracted in the browser with pdfjs-dist goes the same way). DOCX is uploaded; PDFs are judged but not read by the service.

1. `POST /v1/documents` registers a file (type, size, SHA-256) and returns a presigned PUT for a random key `pending/<owner>/<uuid>` in the private quarantine bucket. The grant is valid for 5 minutes and signs the content type, content length and `x-amz-checksum-sha256`, so S3 refuses any other bytes.
2. `POST /v1/documents/{id}/complete` looks the object up, checks size and checksum, **pins its S3 version id** and writes a `document.validate` outbox event in the same transaction. Nothing after this point can change what is accepted: validation reads that version only, and recomputes size and SHA-256 over the bytes it read.
3. The worker validates (`src/worker/documents.ts`): DOCX goes through `src/lib/extract/docx.ts`, which reads the ZIP directory before inflating anything (entry count, declared and total size, ratio, path tricks, encryption), rejects macros, ActiveX, external content relationships, DOCTYPE/entities and password-protected files, reads text, tables and breaks with a fixed tag grammar (tracked deletions ignored, text boxes read once), and warns about images and embedded objects it did not read. Text over 100,000 characters is rejected, never truncated. The result is a private artifact `results/<owner>/documents/<id>/text.json` with its version, SHA-256, length and extractor version. The document is `ready` only after all of that; every failure is a typed rejection with a fixed, actionable message.
4. Deleting a document revokes it immediately and removes its objects; a worker that finishes after a delete removes its own artifact. Both buckets also expire objects by lifecycle (24 h uploads, 7 d results).

**Textract** is built but off: `startOcr`/`completeOcr` (`src/worker/ocr.ts`) check the 3-page product limit before any paid call, start with a token derived from the document and pinned version (a redelivery returns the same operation), store the provider job id and return, so no Lambda waits. Textract's SNS/SQS completion reaches the `ocr` function, which only finishes the document it was waiting for (stale, duplicate and early notifications are ignored or retried), paginates all results, merges by page, reports missing pages as warnings and never fills them in. It runs only for content types listed in `OCR_CONTENT_TYPES`, which is empty: the ticket reads PDFs in the browser and DOCX deterministically, so nothing is sent to Textract today.

## Model calls and parse_document (MDI-217)

`parse_document` (`src/worker/parse.ts`), `analyze_resume` and `generate_questions` (MDI-218, below), and `improve_profile` and `improve_resume` (MDI-219, below) have executors; the guarded, budgeted call they share is `src/worker/paid.ts`. `tailor_resume` still fails at once with `dependency_unavailable`.

- **Model and prompt.** Nova 2 Lite through the US geographic profile `us.amazon.nova-2-lite-v1:0`, called with Bedrock Converse from `BEDROCK_REGION` (us-west-1). The model, the system prompt, the tool schema and the output allocation are code in `src/lib/prompts/parse-document.ts` under `PROMPT_VERSION`; a change to any of them is a new version, and every result records `promptVersion` and `modelId`. There is no fallback model and nothing a request can choose.
- **Forced tool, quoted values.** The model gets one tool, `record_resume`, with tool choice pinned to it; the tool records output and runs nothing. It must copy every value from the resume, dates included. `src/lib/parse` then keeps a value only if it is found in the text (exact, then case and whitespace tolerant, never fuzzy), records its offsets as evidence, and reads dates deterministically (`Mar 2020` is a month, `2019` a year, `03/04/2020` is ambiguous and stays empty). `current` is true only for "Present" and similar. Values that are not in the text, do not fit their field or have unreadable dates become `null` with an uncertainty; resume lines that ended up in no field become warnings. Any of those makes the result `partial`. Seniority is never inferred.
- **Untrusted input.** The resume is wrapped in a marker derived from its own hash and the system prompt says it is data. Before the first model call the whole text goes through the pinned Bedrock guardrail (prompt-attack filter, `source: INPUT`, chunks of 20,000 characters with overlap). An intervention ends the job with `input_policy_blocked`; an unavailable check retries and never falls through to inference.
- **Validation and repair.** The tool input is validated with the same zod schema the tool's JSON Schema is generated from, then the whole result envelope with the contract. One repair call is allowed, with field paths and error codes only. `max_tokens` fails with `output_truncated`, a filtered answer or no tool call with `model_refusal`; a cut-off result is never published.
- **Money.** Prices are in `src/lib/model/pricing.ts` (`PRICING_VERSION`, recorded on every job). Nova 2 Lite has no CountTokens, so the input bound is the request's UTF-8 size plus a template allowance: every token covers at least one byte. Admission refuses text whose worst case (input bound, guardrail units, minimum output of 4,096 tokens) cannot fit the job budget with `budget_exceeded_preflight`. Before each paid call the worker writes the call's worst case to the job's ledger (its checkpoints, under the lease), calls only if it fits what is left of the USD 0.05 cap, and replaces the bound with the metered charge afterwards. A call whose outcome is unknown stays counted at its bound. The job's committed spend is the ledger total.
- **Inputs.** The admitted request is stored next to the job as content (`INPUT#<jobId>`, 7 days). Document input is read from its pinned artifact version and checked against its SHA-256; a deleted document ends the job with `revoked`.
- **Logs.** Model calls log the request id, stop reason, token counts and cost; never prompts, resume text or model output.

**Smoke test and golden set.** `BEDROCK_SMOKE=1 BEDROCK_REGION=us-west-1 GUARDRAIL_ID=... GUARDRAIL_VERSION=... yarn smoke:bedrock`, with credentials for the target account, checks that the guardrail passes a resume and blocks a prompt attack, then parses the golden set (`src/test/fixtures/golden.ts`) end to end and fails if any job exceeds the cap or the p95 metered cost exceeds USD 0.04. It prints ids, outcomes and money only.

## Analysis and questions (MDI-218)

`analyze_resume` (`src/worker/analyze.ts`) and `generate_questions` (`src/worker/questions.ts`) run against a session's context revision. They use the same model, guardrail, ledger and repair rules as parsing; the prompts are `src/lib/prompts/analyze-resume.ts` and `generate-questions.ts`.

- **What the model sees.** A context revision now keeps its source snapshot and job description (session items `CTX#`, `SRC#`, `JD#`, expiring with the session). The worker lists the source as one field per line with a handle (`[F12] experience <id> jobTitle: ...`), followed by the job description and the answers that still apply. Contacts, names, links and recommendations are left out. All of it is fenced as data and checked by the input guardrail first.
- **Grounding.** The model cites a handle and quotes from that field; `src/lib/career/view.ts` turns the pair into evidence with offsets or drops it. Requirements must be quoted from the job description and are never evidence for the candidate. Coverage that claims support without candidate evidence becomes `missing`. Findings that need evidence and have none, fall outside the requested sections, or give a score ("ATS", "85% match") are dropped with a warning (`src/lib/analysis`).
- **Questions.** Zero to five per set; zero is a valid result. A question is kept only if it points at a source entity or section, an analysis finding or a requirement; its topic was not asked before in the session; and it states no number the source does not contain. Guidance with a number is removed. Ids are issued by the service (`r<round>-q<n>`) (`src/lib/questions`). An `analysisJobId` is used only if that job succeeded in the same session for the same source and job description; otherwise the result carries `analysis_not_used`.
- **Rounds and slots.** Admission takes the session's next question round and its question slots (`maxQuestions`, within the ten per session) in the same transaction as the job. A second request for a round that is running or issued, or a round out of order, gets 409 `stale_context`. A round whose job failed, was cancelled or expired can be taken again. Issuing a set commits the round and the number of questions issued, but only while the job still holds the round. The set id is checkpointed first, so a repeat after a lost response publishes the same set without a second model call.
- **Answers.** The latest answer per question applies, skips remove it, and answers to a set issued for another source or job description are ignored. Every topic issued in the session counts as asked.
- **Money.** Admission refuses an analysis or questions job whose worst case does not fit the job budget (`budget_exceeded_preflight`). On the session golden set (`src/test/fixtures/session-golden.ts`) the worst case of one call, guardrail included, is at most about USD 0.027 for analysis and USD 0.018 for questions (`src/lib/model/session-budget.spec.ts`). `yarn smoke:bedrock` measures the metered cost of both operations on that set.

## Improvement proposals (MDI-219)

`improve_profile` and `improve_resume` (`src/worker/improve.ts`) return a proposal the user reviews; nothing in the service saves a profile or resume. They use the same session context, guardrail, ledger and repair rules as analysis. The prompt is `src/lib/prompts/improve.ts`.

- **Operation and source.** `improve_profile` needs a profile source and `improve_resume` a resume source; admission refuses a mismatch with 400 `invalid_request`. The apply target comes from `applyTargetFor` in the contracts: a profile, a mutable resume at its revision, or the draft family of a generated resume.
- **Compact output.** The model sees each description paragraph or list item and each bullet as its own handle. It returns only the fields it changes, as a list of lines: an original line kept by handle, or new text with the handles it replaces. It never re-emits unchanged text.
- **Nothing is erased.** Any original line the model leaves out is put back where it was, so an empty or partial answer cannot remove a bullet or paragraph. Kept lines are copied with their exact marks and links. A field that comes back unchanged is not a change. Each change carries the field's exact original value as its apply precondition, and the proposal carries the source revision and hash.
- **Fact checks** (`src/lib/improve/support.ts`). A new line that states a number, name or credential found nowhere in the candidate's text or answers is blocked, with a warning. One that takes a fact from an answer is a `factual_addition` with answer evidence. One that moves a fact from elsewhere in the source, adds new words or drops a hedge or negation ("helped", "not") becomes a claim the user must confirm. A line that only reorders or trims its own words needs no confirmation, but only for English text without numbers: a line with numbers, or in a script the word rules cannot read, always needs confirmation. Only answered questions are used; a skipped question is never a fact.
- **Conflicts.** A change to an entry that ends before it starts, is current with an end date, or is a full-time role overlapping another full-time role always needs the user's confirmation.
- **Scope.** Person role and tagline, experience description and bullets, and education and project descriptions can change; employers, titles and dates cannot. A role change always needs confirmation. Recommendations are written by other people and are not rewritten. Skills, tools and languages are proposed as additions only when an answer names them and they are not already listed.
- **Money.** On the session golden set the worst case of one improvement call, guardrail included, is at most about USD 0.027 (`src/lib/model/session-budget.spec.ts`). `yarn smoke:bedrock` also measures its metered cost.
