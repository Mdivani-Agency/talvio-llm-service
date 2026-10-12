import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/*
 * Contract fixtures shipped with the package (fixtures/<group>/<name>.json). Both repos run
 * them through the same schemas, so contract tests need no live model calls.
 * - valid/: must parse with the schema named in the file.
 * - invalid/: must be rejected by that schema.
 * - legacy/: payloads the current web routes exchange today.
 */

export type FixtureGroup = 'valid' | 'invalid' | 'legacy';

export type Fixture = {
  /** File name without .json. */
  name: string;
  group: FixtureGroup;
  /** Export name of the schema the payload is checked against, e.g. `createJobRequestSchema`. */
  schema: string;
  description: string;
  /** `json-string`: the payload is JSON encoded inside a string, as a legacy route sends it. */
  encoding?: 'json-string';
  payload: unknown;
};

/** Package root: one level up from src/ and from dist/. */
const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

export function loadFixtures(group?: FixtureGroup): Fixture[] {
  const groups: FixtureGroup[] = group ? [group] : ['valid', 'invalid', 'legacy'];
  return groups.flatMap((name) =>
    readdirSync(join(FIXTURES_DIR, name))
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => {
        const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, name, file), 'utf8')) as Omit<
          Fixture,
          'name' | 'group'
        >;
        return { ...raw, name: file.replace(/\.json$/, ''), group: name };
      }),
  );
}

export function loadFixture(group: FixtureGroup, name: string): Fixture {
  const fixture = loadFixtures(group).find((item) => item.name === name);
  if (!fixture) {
    throw new Error(`Unknown fixture ${group}/${name}`);
  }
  return fixture;
}
