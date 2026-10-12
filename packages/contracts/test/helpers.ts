import { z } from 'zod';

import * as contracts from '../src';
import type { Fixture } from '../src/fixtures';

/** Resolves a fixture's schema name (`createJobRequestSchema`, `resultEnvelopeSchemas.tailor_resume`). */
export function schemaFor(fixture: Fixture): z.ZodType {
  const [name, key] = fixture.schema.split('.');
  const exported = (contracts as Record<string, unknown>)[name];
  const schema = key ? (exported as Record<string, unknown> | undefined)?.[key] : exported;
  if (!(schema instanceof z.ZodType)) {
    throw new Error(
      `Fixture ${fixture.group}/${fixture.name} names unknown schema ${fixture.schema}`,
    );
  }
  return schema;
}

/** The payload as the schema should see it; legacy string-encoded bodies are decoded once. */
export function payloadOf(fixture: Fixture): unknown {
  return fixture.encoding === 'json-string'
    ? JSON.parse(fixture.payload as string)
    : fixture.payload;
}
