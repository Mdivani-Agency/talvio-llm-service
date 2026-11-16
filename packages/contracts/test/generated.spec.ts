import { readFileSync } from 'fs';
import { join } from 'path';

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { NAMED_SCHEMAS, buildJsonSchemas, buildOpenApiDocument } from '../src';
import { loadFixtures } from '../src/fixtures';

const generated = (file: string) =>
  JSON.parse(readFileSync(join(__dirname, '..', 'generated', file), 'utf8')) as unknown;

/** Fixture schema export name → published schema name. */
const PUBLISHED: Record<string, keyof typeof NAMED_SCHEMAS> = {
  careerDocumentSchema: 'CareerDocument',
  createDocumentRequestSchema: 'CreateDocumentRequest',
  createSessionRequestSchema: 'CreateSessionRequest',
  submitAnswersRequestSchema: 'SubmitAnswersRequest',
  createJobRequestSchema: 'CreateJobRequest',
  jobSchema: 'Job',
  errorBodySchema: 'ErrorBody',
  applyRequestSchema: 'ApplyRequest',
};

describe('generated artifacts', () => {
  it('openapi.json is up to date (run `yarn generate`)', () => {
    expect(generated('openapi.json')).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });

  it.each(Object.keys(NAMED_SCHEMAS))('schemas/%s.json is up to date', (name) => {
    const schemas = buildJsonSchemas() as Record<string, unknown>;
    expect(generated(`schemas/${name}.json`)).toEqual(JSON.parse(JSON.stringify(schemas[name])));
  });
});

describe('JSON Schema consumers', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validators = Object.fromEntries(
    Object.entries(buildJsonSchemas()).map(([name, schema]) => [name, ajv.compile(schema)]),
  );

  const published = loadFixtures('valid').filter((fixture) => PUBLISHED[fixture.schema]);

  it('covers at least one fixture per published request schema', () => {
    expect(new Set(published.map((fixture) => fixture.schema)).size).toBeGreaterThanOrEqual(7);
  });

  it.each(published.map((fixture) => [fixture.name, fixture] as const))(
    '%s validates against the published JSON Schema',
    (_name, fixture) => {
      const validate = validators[PUBLISHED[fixture.schema]];
      expect(validate(fixture.payload) ? [] : validate.errors).toEqual([]);
    },
  );

  it('rejects structurally invalid fixtures that JSON Schema can express', () => {
    const structural = [
      'job-request-model-override',
      'job-request-unknown-operation',
      'job-request-unsupported-version',
      'session-jd-too-long',
      'career-guessed-datetime',
      'career-tiptap-json',
    ];
    for (const fixture of loadFixtures('invalid').filter((item) =>
      structural.includes(item.name),
    )) {
      expect(validators[PUBLISHED[fixture.schema]](fixture.payload)).toBe(false);
    }
  });
});
