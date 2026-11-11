import type { ContentBlock, ContentDoc, InlineText } from '@talvio/llm-contracts';

/*
 * A content document seen as lines: one per paragraph and one per list item, in reading order,
 * the same order `contentToPlainText` uses. A proposal keeps or rewrites lines; kept lines are
 * copied back with their exact inline nodes (marks and links), so unchanged rich text survives.
 */

export type ListKind = 'bulletList' | 'orderedList';

export type ContentLine = {
  /** `paragraph`, or the kind of list the line is an item of. */
  kind: 'paragraph' | ListKind;
  /** Index of the block the line came from. */
  block: number;
  inline: InlineText[];
  text: string;
};

export function contentLines(doc: ContentDoc): ContentLine[] {
  const text = (inline: InlineText[]) => inline.map((node) => node.text).join('');
  return doc.blocks.flatMap((block, index): ContentLine[] =>
    block.type === 'paragraph'
      ? [{ kind: 'paragraph', block: index, inline: block.content, text: text(block.content) }]
      : block.items.map((inline) => ({
          kind: block.type,
          block: index,
          inline,
          text: text(inline),
        })),
  );
}

/** A line of a rebuilt document: a kept original, or new plain text in a paragraph or list. */
export type BuiltLine = { kept: ContentLine } | { text: string; kind: 'paragraph' | ListKind };

/**
 * Builds a document from lines. Consecutive list lines of one kind share a list, except that
 * kept lines from two different original lists stay in separate lists.
 */
export function buildContent(lines: BuiltLine[]): ContentDoc {
  type OpenList = { kind: ListKind; origin: number | null; items: InlineText[][] };
  const blocks: ContentBlock[] = [];
  const toBlock = (list: OpenList): ContentBlock => ({ type: list.kind, items: list.items });
  let open: OpenList | null = null;
  for (const line of lines) {
    const kind = 'kept' in line ? line.kept.kind : line.kind;
    const inline = 'kept' in line ? structuredClone(line.kept.inline) : [{ text: line.text }];
    if (kind === 'paragraph') {
      if (open) blocks.push(toBlock(open));
      open = null;
      blocks.push({ type: 'paragraph', content: inline });
      continue;
    }
    const origin = 'kept' in line ? line.kept.block : null;
    if (
      !open ||
      open.kind !== kind ||
      (origin !== null && open.origin !== null && open.origin !== origin)
    ) {
      if (open) blocks.push(toBlock(open));
      open = { kind, origin, items: [] };
    }
    open.items.push(inline);
    open.origin ??= origin;
  }
  if (open) blocks.push(toBlock(open));
  return { type: 'doc', blocks };
}
