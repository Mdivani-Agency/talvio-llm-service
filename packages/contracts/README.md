# @talvio/llm-contracts

Versioned request and result contracts for the Talvio LLM service (`/llm/v1`): Zod schemas, TypeScript types, generated OpenAPI and JSON Schema, and fixtures both repositories test against.

See [docs/contracts.md](../../docs/contracts.md) for the rules, versioning and rollout ownership.

```ts
import { createJobRequestSchema, jobSchema, applyTargetFor } from '@talvio/llm-contracts';
import { loadFixtures } from '@talvio/llm-contracts/fixtures';
```

```bash
yarn test       # contract tests; no network or model calls
yarn typecheck
yarn generate   # rebuild generated/ after a schema change
```
