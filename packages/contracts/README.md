# @talvio/llm-contracts

The source of the LLM service's `/llm/v1` contract: Zod schemas and TypeScript types used by this service, the generated OpenAPI and JSON Schema, and reference fixtures.

**Consumers do not import this package** (decision 12 Oct 2026). Clients such as talvio-web-app implement their own client, as for any third-party API, from:

- [docs/contracts.md](../../docs/contracts.md): rules, versioning and rollout ownership;
- `generated/openapi.json` and `generated/schemas/*.json`: the machine-readable contract;
- `fixtures/valid` and `fixtures/invalid`: reference payloads a client can use in its own tests.

Read these files from this repository at the tag or commit the service deploys. Publishing the package to npm is deferred to [MDI-439](https://linear.app/mdivani/issue/MDI-439).

Inside this repository:

```bash
yarn test       # contract tests; no network or model calls
yarn typecheck
yarn generate   # rebuild generated/ after a schema change; commit the result
```
