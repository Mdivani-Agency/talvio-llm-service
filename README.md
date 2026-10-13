# Talvio LLM service

Talvio's AI orchestration service: an authenticated async job API at `https://api.<stage>.talvio.co/llm/v1` for parsing documents, analysing and improving profiles and resumes, gap questions and job-specific resumes. Design: [Talvio LLM orchestration service — system design](https://app.notion.com/p/3daf87a6db5781eb93d5e25326f24619) (epic [MDI-181](https://linear.app/mdivani/issue/MDI-181)).

**Status:** API boundary only ([MDI-212](https://linear.app/mdivani/issue/MDI-212)). Authentication, routing, request validation and idempotency checks run. No store, queue or model is wired yet, so every route except health answers `503 dependency_unavailable` on deployed stages. Persistence arrives with MDI-214 (DynamoDB, Terraform-owned), execution with MDI-215, and models with MDI-217. The service is self-contained: its data lives in its own AWS resources, and it shares nothing with the web app's database except the identity in the access token.

## Layout

| Path                                  | Contents                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/contracts`                  | `@talvio/llm-contracts`: request/result schemas, OpenAPI, fixtures ([docs/contracts.md](docs/contracts.md)) |
| `src/handler.ts`                      | Lambda entry; validates configuration once per container                                                    |
| `src/api/route-table.ts`              | Every route; `serverless.ts` creates one API Gateway event per entry                                        |
| `src/api/app.ts`                      | Request pipeline: correlation id, authentication, active-account check, body parsing, safe errors, logging  |
| `src/api/handlers/`                   | Documents, sessions and jobs                                                                                |
| `src/lib/auth.ts`                     | Supabase JWT verification                                                                                   |
| `src/lib/store/`                      | Owner-scoped store interfaces, plus the `memory` (local/test) and `unconfigured` implementations            |
| `src/lib/config.ts`, `src/lib/log.ts` | Configuration validation and content-free logging                                                           |

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
- **Permissions.** The functions have no AWS permissions. It cannot call Bedrock or read any bucket. MDI-213 adds scoped roles.

## Stages and configuration

| Variable                                                                          | Source                                          | Notes                                                                 |
| --------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| `STAGE`                                                                           | `--stage`                                       | `local`, `test`, `dev`, `prod`                                        |
| `SUPABASE_URL`                                                                    | SSM `/<stage>/supabase/url` (local: shell/.env) | https outside local/test                                              |
| `STORE_DRIVER`                                                                    | `serverless.ts` per stage                       | `unconfigured` on dev/prod until MDI-214; `memory` only on local/test |
| `SUPABASE_JWT_AUDIENCE`, `SUPABASE_JWT_ALGORITHMS`, `MAX_BODY_BYTES`, `LOG_LEVEL` | defaults                                        | see `src/lib/config.ts`                                               |

An invalid configuration makes every route, health included, answer 503, and the log names only the variables that failed.

## Deploy

The API is served at `api.<domain>/llm` through a base path mapping on the shared custom domain. This stack does not create the domain or its DNS record. CI runs on every pull request; deploying to dev is a manual `workflow_dispatch` with `deploy: true` until MDI-213 lands. It assumes the `AWS_DEPLOY_ROLE_ARN` environment variable (OIDC) and a Serverless Framework 4 access or license key.
