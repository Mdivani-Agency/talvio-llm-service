import { LIMITS } from '@talvio/llm-contracts';

import { RejectedDocumentError } from './errors';

/** Bump when extraction output changes; stored with every artifact so old results stay traceable. */
export const EXTRACTOR_VERSION = 'text-1';

/**
 * Normalizes extracted or submitted text: NFC, LF line ends, no control characters, no trailing
 * space, at most one blank line in a row. Never truncates: over the limit is a rejection, so a
 * silently shortened document can never look complete.
 */
export function normalizeText(raw: string): string {
  const text = raw
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length === 0) throw new RejectedDocumentError('empty');
  if (text.length > LIMITS.sourceTextChars) throw new RejectedDocumentError('too_long');
  return text;
}
