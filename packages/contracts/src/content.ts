import { z } from 'zod';

import { LIMITS } from './limits';

/**
 * Compact rich-text AST used across the contract instead of TipTap JSON (design §9).
 * The web converts its TipTap documents to this AST before submitting and converts accepted
 * proposals back. Only the nodes and marks below exist; anything else is rejected, so a model
 * cannot smuggle unsupported markup into a saved document.
 */
export const inlineMarkSchema = z.enum(['bold', 'italic', 'underline']);

export const inlineTextSchema = z.strictObject({
  text: z.string().min(1).max(LIMITS.longTextChars),
  marks: z.array(inlineMarkSchema).max(3).optional(),
  /** Only https links; rendered as a link mark. */
  href: z
    .url({ protocol: /^https$/ })
    .max(2_048)
    .optional(),
});

const inlineContentSchema = z.array(inlineTextSchema).max(200);

export const paragraphBlockSchema = z.strictObject({
  type: z.literal('paragraph'),
  content: inlineContentSchema,
});

export const bulletListBlockSchema = z.strictObject({
  type: z.literal('bulletList'),
  items: z.array(inlineContentSchema).max(LIMITS.bulletsPerEntry),
});

export const orderedListBlockSchema = z.strictObject({
  type: z.literal('orderedList'),
  items: z.array(inlineContentSchema).max(LIMITS.bulletsPerEntry),
});

export const contentBlockSchema = z.discriminatedUnion('type', [
  paragraphBlockSchema,
  bulletListBlockSchema,
  orderedListBlockSchema,
]);

export const contentDocSchema = z.strictObject({
  type: z.literal('doc'),
  blocks: z.array(contentBlockSchema).max(100),
});

export type InlineText = z.infer<typeof inlineTextSchema>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type ContentDoc = z.infer<typeof contentDocSchema>;

/** Plain text of a content document, one line per paragraph or list item. */
export function contentToPlainText(doc: ContentDoc): string {
  const line = (inline: InlineText[]) => inline.map((node) => node.text).join('');
  return doc.blocks
    .flatMap((block) =>
      block.type === 'paragraph' ? [line(block.content)] : block.items.map(line),
    )
    .join('\n');
}
