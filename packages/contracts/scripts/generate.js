// Writes generated/openapi.json and generated/schemas/<Name>.json from the built package.
// Run with `yarn generate`; test/generated.spec.ts fails when the committed files are stale.
const { mkdirSync, rmSync, writeFileSync } = require('fs');
const { join } = require('path');

const { buildJsonSchemas, buildOpenApiDocument } = require('../dist');

const root = join(__dirname, '..', 'generated');
const write = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'schemas'), { recursive: true });
write(join(root, 'openapi.json'), buildOpenApiDocument());
for (const [name, schema] of Object.entries(buildJsonSchemas())) {
  write(join(root, 'schemas', `${name}.json`), schema);
}
