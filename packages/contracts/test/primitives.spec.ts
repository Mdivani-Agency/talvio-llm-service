import {
  LIMITS,
  OPERATIONS,
  canonicalJson,
  contentToPlainText,
  createJobRequestSchema,
  operationInputSchemas,
  operationResultSchemas,
  partialDateSchema,
} from '../src';

describe('canonicalJson', () => {
  it('sorts keys and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, undefined] } })).toBe(
      '{"a":{"c":[2,null]},"b":1}',
    );
  });
});

describe('partialDateSchema', () => {
  it.each(['2024', '2024-03', '2024-03-15'])('accepts %s', (value) => {
    expect(partialDateSchema.safeParse(value).success).toBe(true);
  });
  it.each(['24', '2024-13', '2024-03-32', '2024-03-15T00:00:00Z', ''])('rejects %s', (value) => {
    expect(partialDateSchema.safeParse(value).success).toBe(false);
  });
});

describe('contentToPlainText', () => {
  it('joins paragraphs and list items by line', () => {
    expect(
      contentToPlainText({
        type: 'doc',
        blocks: [
          { type: 'paragraph', content: [{ text: 'Led ' }, { text: 'payments', marks: ['bold'] }] },
          { type: 'bulletList', items: [[{ text: 'one' }], [{ text: 'two' }]] },
        ],
      }),
    ).toBe('Led payments\none\ntwo');
  });
});

describe('operations', () => {
  it('defines an input and a result schema for every operation', () => {
    expect(Object.keys(operationInputSchemas).sort()).toEqual([...OPERATIONS].sort());
    expect(Object.keys(operationResultSchemas).sort()).toEqual([...OPERATIONS].sort());
  });

  it('enforces source text limits at admission', () => {
    const request = (text: string) => ({
      schemaVersion: '1.0',
      clientRequestId: 'parse-12345678',
      operation: 'parse_document',
      input: { kind: 'text', text, extraction: null },
    });
    expect(
      createJobRequestSchema.safeParse(request('x'.repeat(LIMITS.sourceTextChars))).success,
    ).toBe(true);
    expect(
      createJobRequestSchema.safeParse(request('x'.repeat(LIMITS.sourceTextChars + 1))).success,
    ).toBe(false);
    expect(createJobRequestSchema.safeParse(request('   ')).success).toBe(false);
  });

  it('defaults the locale', () => {
    const parsed = createJobRequestSchema.parse({
      schemaVersion: '1.0',
      clientRequestId: 'parse-12345678',
      operation: 'parse_document',
      input: { kind: 'document', documentId: '0a1b2c3d-4e5f-4a6b-9c8d-9e0f1a2b3c4a' },
    });
    expect(parsed.locale).toBe('en-US');
  });
});
