# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md` imports this file.

This is the Talvio LLM service: a Serverless Framework 4 app on AWS (Node 22, TypeScript 5) plus the `@talvio/llm-contracts` workspace package. Read `README.md` for the API and security model and `docs/contracts.md` for contract rules. The system design is the Notion page "Talvio LLM orchestration service — system design".

## Commands

```bash
yarn install
yarn check                       # lint + typecheck + service tests + contract tests
yarn test src/api/app.spec.ts    # one file
yarn workspace @talvio/llm-contracts generate   # after changing a contract schema
```

## Rules

- Contract changes go in `packages/contracts` first; run `generate` and commit `generated/`. Breaking changes need a new major version (see docs/contracts.md).
- A route exists only if it is in `src/api/route-table.ts`. Only health is public.
- Handlers use the owner-scoped store interfaces in `src/lib/store/types.ts`; never query by id without the owner.
- Never log request bodies, tokens, document text or the message of an unknown error. Use `LogFields`; add a field only if it is content-free. `no-console` is enforced.
- Validation errors carry paths and generic messages only (`src/lib/validation.ts`).
- New behavior ships with a co-located `*.spec.ts`.

## Workflow

Start Linear tickets with `.cursor/commands/start-issue.md`. Conventional Commits with a `Refs: MDI-xxx` footer.
