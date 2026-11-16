import {
  careerDocumentSchema,
  legacyAccountSchema,
  legacyAccountToCareer,
  parseDocumentResultSchema,
  resultEnvelopeSchemas,
} from '../src';
import { loadFixture, loadFixtures } from '../src/fixtures';
import { payloadOf, schemaFor } from './helpers';

describe('valid fixtures', () => {
  it.each(loadFixtures('valid').map((fixture) => [fixture.name, fixture] as const))(
    '%s parses',
    (_name, fixture) => {
      const result = schemaFor(fixture).safeParse(fixture.payload);
      expect(result.error?.issues ?? []).toEqual([]);
    },
  );
});

describe('invalid fixtures', () => {
  it.each(loadFixtures('invalid').map((fixture) => [fixture.name, fixture] as const))(
    '%s is rejected',
    (_name, fixture) => {
      expect(schemaFor(fixture).safeParse(fixture.payload).success).toBe(false);
    },
  );
});

describe('legacy fixtures', () => {
  it.each(loadFixtures('legacy').map((fixture) => [fixture.name, fixture] as const))(
    '%s matches the current web shape',
    (_name, fixture) => {
      expect(schemaFor(fixture).safeParse(payloadOf(fixture)).success).toBe(true);
    },
  );
});

describe('no double-encoded JSON', () => {
  it('rejects a result sent as a JSON string', () => {
    const fixture = loadFixture('invalid', 'parse-result-double-encoded');
    const parsed = resultEnvelopeSchemas.parse_document.safeParse(fixture.payload);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain('result');
  });

  it('accepts the same result as an object', () => {
    const fixture = loadFixture('valid', 'parse-result-partial-profile');
    const result = (fixture.payload as { result: unknown }).result;
    expect(parseDocumentResultSchema.safeParse(result).success).toBe(true);
    expect(parseDocumentResultSchema.safeParse(JSON.stringify(result)).success).toBe(false);
  });
});

describe('legacyAccountToCareer', () => {
  const account = legacyAccountSchema.parse(
    payloadOf(loadFixture('legacy', 'qa-request-account-payload')),
  );
  const career = legacyAccountToCareer(account);

  it('produces a valid career document', () => {
    expect(careerDocumentSchema.safeParse(career).success).toBe(true);
  });

  it('keeps row UUIDs and replaces client list keys', () => {
    expect(career.experience.map((entry) => entry.id)).toEqual([
      '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f51',
      'legacy:experience:1',
    ]);
  });

  it('keeps date precision and only trusts boolean isPresent', () => {
    const [acme, globex] = career.experience;
    expect(acme).toMatchObject({ startDate: '2021-03-01', endDate: null, current: true });
    expect(globex).toMatchObject({
      startDate: '2018-01-01',
      endDate: '2021-02-01',
      current: false,
    });
  });

  it('drops empty list items and maps details to rich text', () => {
    expect(career.skills.map((skill) => skill.name)).toEqual(['Go', 'PostgreSQL']);
    expect(career.experience[0].description).toEqual({
      type: 'doc',
      blocks: [
        { type: 'paragraph', content: [{ text: 'Led the payments platform team at Acme.' }] },
      ],
    });
  });

  it('never marks a parsed role current from a guessed isPresent date', () => {
    const parsed = legacyAccountSchema.parse(
      payloadOf(loadFixture('legacy', 'parse-response-double-encoded')),
    );
    const [role] = legacyAccountToCareer(parsed).experience;
    expect(role).toMatchObject({ endDate: null, current: null, employmentType: null });
    expect(legacyAccountToCareer(parsed).contacts.phone).toBeNull();
  });
});
