import { TAILOR_SOURCE } from '../../test/fixtures/session';
import { buildContent, contentLines } from './content';

const doc = TAILOR_SOURCE.document.experience[0]!.description!;

describe('content lines', () => {
  it('rebuilds a document exactly from its own kept lines', () => {
    expect(buildContent(contentLines(doc).map((kept) => ({ kept })))).toEqual(doc);
  });

  it('puts new list lines into the list beside them and keeps separate lists apart', () => {
    const [paragraph, first, second] = contentLines(doc);
    const twoLists = {
      type: 'doc' as const,
      blocks: [
        { type: 'bulletList' as const, items: [[{ text: 'a' }]] },
        { type: 'bulletList' as const, items: [[{ text: 'b' }]] },
      ],
    };
    expect(buildContent(contentLines(twoLists).map((kept) => ({ kept })))).toEqual(twoLists);
    expect(
      buildContent([
        { kept: paragraph! },
        { kept: first! },
        { text: 'New', kind: 'bulletList' },
        { kept: second! },
        { text: 'Closing', kind: 'paragraph' },
      ]).blocks.map((b) => (b.type === 'paragraph' ? 'p' : b.items.length)),
    ).toEqual(['p', 3, 'p']);
  });
});
