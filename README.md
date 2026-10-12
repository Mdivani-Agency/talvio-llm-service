# Talvio LLM service

Talvio's AI orchestration service: an authenticated async job API at `https://api.<stage>.talvio.co/llm/v1` for parsing documents, analysing and improving profiles and resumes, gap questions and job-specific resumes. Design: [Talvio LLM orchestration service — system design](https://app.notion.com/p/3daf87a6db5781eb93d5e25326f24619) (epic [MDI-181](https://linear.app/mdivani/issue/MDI-181)).

**Status:** API boundary only ([MDI-212](https://linear.app/mdivani/issue/MDI-212)). Authentication, routing, request validation and idempotency checks run. No store, queue or model is wired yet, so every route except health answers `503 dependency_unavailable` on deployed stages. Persistence arrives with MDI-214, execution with MDI-215, and models with MDI-217.

## Layout

| Path | Contents |
| -- | -- |
| `packages/contracts` | `@talvio/llm-contracts`: request/result schemas, OpenAPI, fixtures ([docs/contracts.md](docs/contracts.md)) |
| `src/handler.ts` | Lambda entry; validates configuration once per container |
| `src/api/route-table.ts` | Every route; `serverless.ts` creates one API Gateway event per entry |
| `src/api/app.ts` | Request pipeline: correlation id, authentication, active-account check, body parsing, safe errors, logging |
| `src/api/handlers/` | Documents, sessions and jobs |
| `src/lib/auth.ts` | Supabase JWT verification |
| `src/lib/store/` | Owner-scoped store interfaces, plus the `memory` (local/test) and `unconfigured` implementations |
| `src/lib/config.ts`, `src/lib/log.ts` | Configuration validation and content-free logging |

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
- **Token checks.** Every route except `GET /v1/health` verifies the token against the project's JWKS: signature, issuer `${SUPABASE_URL}/auth/v1`, audience `authenticated`, asymmetric algorithm only (`ES256`/`RS256`), `exp`, a UUID `sub` and `role: authenticated`. Anonymous users are refused, and `user_metadata` is never read. Rotated keys are picked up from JWKS without a deploy.
- **Account and ownership checks.** The account must still be active, so a deleted account's unexpired token is refused. Every store call is scoped by owner; another user's job, session or document is a 404.
- **Admission checks.** `POST /v1/jobs` requires an `Idempotency-Key` header equal to `clientRequestId`. A replay of the same request returns the original job; the same key with a different body returns 409. Requests are validated with the contract schemas, and validation errors list field paths, never values.
- **Logging.** Logs are JSON lines with a fixed set of content-free fields (correlation id, route, status, duration, a hashed user reference, error code). Tokens, bodies, document text and error messages from unknown failures are never logged.
- **Permissions.** The function has no AWS permissions. It cannot call Bedrock or read any bucket. MDI-213 adds scoped roles.

## Stages and configuration

| Variable | Source | Notes |
| -- | -- | -- |
| `STAGE` | `--stage` | `local`, `test`, `dev`, `prod` |
| `SUPABASE_URL` | SSM `/<stage>/supabase/url` (local: shell/.env) | https outside local/test |
| `STORE_DRIVER` | `serverless.ts` per stage | `unconfigured` on dev/prod until MDI-214; `memory` only on local/test |
| `SUPABASE_JWT_AUDIENCE`, `SUPABASE_JWT_ALGORITHMS`, `MAX_BODY_BYTES`, `LOG_LEVEL` | defaults | see `src/lib/config.ts` |

An invalid configuration makes every route, health included, answer 503, and the log names only the variables that failed.

## Deploy

The API is served at `api.<domain>/llm` through a base path mapping on the shared custom domain. This stack does not create the domain or its DNS record. CI runs on every pull request; deploying to dev is a manual `workflow_dispatch` with `deploy: true` until MDI-213 lands. It assumes the `AWS_DEPLOY_ROLE_ARN` environment variable (OIDC) and a Serverless Framework 4 access or license key.
