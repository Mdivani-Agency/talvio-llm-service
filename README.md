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

| Variable                                                                          | Source                                          | Notes                                                                           |
| --------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `STAGE`                                                                           | `--stage`                                       | `local`, `test`, `dev`, `prod`                                                  |
| `SUPABASE_URL`                                                                    | SSM `/<stage>/supabase/url` (local: shell/.env) | https outside local/test                                                        |
| `STORE_DRIVER`                                                                    | `serverless.ts` per stage                       | `dynamodb` on dev/prod; `memory` only on local/test; `unconfigured` answers 503 |
| `LLM_{JOBS,SESSIONS,QUOTAS,OUTBOX}_TABLE`                                         | SSM `/<stage>/dynamodb/llm-*` (dev/prod)        | Terraform-owned tables; required by the `dynamodb` driver                       |
| `ACCOUNT_DAILY_CEILING_MICRO_USD`                                                 | default `25000000` (USD 25)                     | account-wide spend per UTC day; set per stage when the real ceiling is decided  |
| `SUPABASE_JWT_AUDIENCE`, `SUPABASE_JWT_ALGORITHMS`, `MAX_BODY_BYTES`, `LOG_LEVEL` | defaults                                        | see `src/lib/config.ts`                                                         |

An invalid configuration makes every route, health included, answer 503, and the log names only the variables that failed.

## Deploy

The API is served at `api.<domain>/llm` through a base path mapping on the shared custom domain. This stack does not create the domain or its DNS record. CI runs on every pull request; deploying to dev is a manual `workflow_dispatch` with `deploy: true`. It assumes the `AWS_DEPLOY_ROLE_ARN` variable on the `dev` (or `prod`) GitHub Environment, set to the `llm_deploy_role_arn` output of talvio-terraform-iac's main root (also SSM `/<stage>/ci/llm-deploy-role-arn`), and a Serverless Framework 4 access or license key. That role trusts only this repository's `environment:<stage>` OIDC subject, so a dev job cannot assume the prod role. Apply the Terraform platform for the stage first: the stack reads `/<stage>/llm/*` from SSM and fails fast if it is missing.

## State, quotas and retention (MDI-214)

All state is in the four Terraform-owned DynamoDB tables (`src/lib/store/dynamo/db.ts` documents the key layout). Every key starts with the owner, every read and write is owner-scoped, and no access pattern scans.

- **Admission** is one `TransactWriteItems`: the job, its idempotency record, the quota and spend holds (user day, user active, account day) and the outbox event. A replay is answered before any of that and consumes no quota. Transactions are never held across model or OCR calls.
- **Limits** come from `src/lib/limits.ts` (20 jobs per UTC day, 2 active, USD 1.00 per day, USD 0.05 per job, planning budget USD 0.10, account ceiling) by the token's `plan`, and a per-user override item (`U#<user>` / `LIMITS` in the quotas table, any subset of the fields) changes them without a deploy.
- **Retention** is DynamoDB TTL on `expiresAt`: incomplete uploads 24 h, result payloads, sessions, documents and answers 7 days, job metadata, idempotency records and outbox events 30 days. TTL deletion can lag, so reads also treat an expired item as missing.
- **Outbox** events sit in a sparse index until the dispatcher (MDI-215) marks them dispatched.

Tests: the same contract suite (`src/lib/store/store.contract.ts`) runs on the memory store and, when `TEST_DYNAMODB_ENDPOINT` is set, on DynamoDB Local. CI starts DynamoDB Local as a service container; locally, point the variable at any DynamoDB Local (`http://localhost:8000`).
