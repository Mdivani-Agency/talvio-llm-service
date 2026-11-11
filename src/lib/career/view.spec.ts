import { evidenceRefSchema } from '@talvio/llm-contracts';

import { TAILOR_SOURCE, handle } from '../../test/fixtures/session';
import { careerView, groundCitation, groundText } from './view';

const HASH = 'a'.repeat(64);
const ACME = '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f51';

describe('careerView', () => {
  const view = careerView(TAILOR_SOURCE.document);

  it('lists the fields analysis needs, with handles, and leaves out contacts, names and links', () => {
    expect(view.text).toContain(
      `[${handle(view, ACME, 'jobTitle')}] experience ${ACME} jobTitle: Senior Backend Engineer`,
    );
    expect(view.text).toContain('Cut checkout latency by 40%');
    expect(view.text).not.toMatch(/nino@example\.com|Nino|Beridze|github\.com|acme\.example\.com/);
    expect(view.entities.get(ACME)).toBe('experience');
    expect(view.entities.get('legacy:links:0')).toBeUndefined();
  });

  it('turns a handle and quote into evidence with offsets, or nothing', () => {
    const ref = groundCitation(view, TAILOR_SOURCE, HASH, {
      ref: handle(view, ACME, 'description'),
      quote: 'payments platform',
    });
    expect(evidenceRefSchema.parse(ref)).toMatchObject({
      sourceKind: 'profile',
      entityId: ACME,
      field: 'description',
      excerpt: 'payments platform',
      start: 8,
      end: 25,
    });
    // A whole field when no quote is given.
    expect(
      groundCitation(view, TAILOR_SOURCE, HASH, {
        ref: handle(view, ACME, 'company'),
        quote: null,
      }),
    ).toMatchObject({ excerpt: 'Acme', start: 0, end: 4 });
    expect(
      groundCitation(view, TAILOR_SOURCE, HASH, {
        ref: handle(view, ACME, 'company'),
        quote: 'Initech',
      }),
    ).toBeNull();
    expect(groundCitation(view, TAILOR_SOURCE, HASH, { ref: 'F999', quote: null })).toBeNull();
  });

  it('grounds quotes in free text', () => {
    const ref = groundText('Required: Go. Preferred: Kafka.', 'kafka', {
      sourceKind: 'job_description',
      sourceHash: HASH,
      questionId: null,
      answerRevisionId: null,
    });
    expect(ref).toMatchObject({ excerpt: 'Kafka', start: 25, end: 30 });
    expect(
      groundText('Required: Go.', 'Rust', {
        sourceKind: 'job_description',
        sourceHash: HASH,
        questionId: null,
        answerRevisionId: null,
      }),
    ).toBeNull();
  });
});
