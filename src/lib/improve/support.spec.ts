import { CONFLICTING_SOURCE, SPARSE_SOURCE, TAILOR_SOURCE } from '../../test/fixtures/session';
import { conflictingEntities, factTokens, lineSupport } from './support';

const ctx = { sourceText: 'Acme\nGo\nPostgreSQL\nKafka', answers: [] };

describe('factTokens', () => {
  it('finds numbers, names, acronyms, technical terms and credentials', () => {
    expect(
      factTokens(
        'Moved 3 services to Kafka and AWS with Node.js and C#; became a certified architect.',
      ),
    ).toEqual(expect.arrayContaining(['3', 'certified', 'Kafka', 'AWS', 'Node.js', 'C#']));
  });

  it('does not count an ordinary capitalized word that starts a sentence', () => {
    expect(factTokens('Reduced latency. Improved uptime.')).toEqual([]);
  });
});

describe('lineSupport', () => {
  it('lets a line name facts of its own entry', () => {
    expect(
      lineSupport(
        'Shipped payments at Acme',
        { original: 'Shipped payments', nearby: 'Acme' },
        ctx,
      ),
    ).toEqual({ status: 'kept_words' });
  });

  it('asks to confirm a fact moved in from elsewhere in the source', () => {
    expect(lineSupport('Built services in Go', { original: 'Built services' }, ctx)).toEqual({
      status: 'confirm',
    });
  });
});

describe('conflictingEntities', () => {
  it('flags overlapping full-time roles and nothing in a consistent profile', () => {
    expect([...conflictingEntities(CONFLICTING_SOURCE.document).keys()]).toEqual([
      'exp-conflict-1',
      'exp-conflict-2',
    ]);
    expect(conflictingEntities(TAILOR_SOURCE.document).size).toBe(0);
    expect(conflictingEntities(SPARSE_SOURCE.document).size).toBe(0);
  });

  it('flags an entry that ends before it starts or is current with an end date', () => {
    const document = structuredClone(TAILOR_SOURCE.document);
    document.experience[1]!.endDate = '2017';
    document.education[0]!.current = true;
    expect(conflictingEntities(document)).toEqual(
      new Map([
        [document.experience[1]!.id, 'This entry ends before it starts.'],
        [document.education[0]!.id, 'This entry is marked current but has an end date.'],
      ]),
    );
  });
});
