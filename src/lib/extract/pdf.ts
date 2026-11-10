import { RejectedDocumentError } from './errors';
import { LIMITS } from '@talvio/llm-contracts';

/*
 * A structural look at an uploaded PDF, without parsing it: the header, an encryption dictionary,
 * XFA forms, script actions and the page count are all visible as tokens in the file. The checks
 * are conservative (a match rejects), cheap and bounded by the 10 MB upload limit. Nothing here
 * interprets PDF content, so a hostile file cannot run anything.
 */

export type PdfInspection = { pages: number };

export function inspectPdf(bytes: Uint8Array): PdfInspection {
  // latin1 maps bytes 1:1, so binary streams cannot throw and tokens match as in the file.
  const text = Buffer.from(bytes).toString('latin1');
  if (!text.slice(0, 1024).includes('%PDF-')) throw new RejectedDocumentError('malformed');
  if (/\/Encrypt\b/.test(text)) throw new RejectedDocumentError('encrypted');
  if (/\/XFA\b|\/JavaScript\b|\/JS\b|\/Launch\b|\/EmbeddedFile\b/.test(text)) {
    throw new RejectedDocumentError('unsafe');
  }
  const pages = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  if (pages === 0) throw new RejectedDocumentError('malformed');
  if (pages > LIMITS.pdfPages) throw new RejectedDocumentError('too_large');
  return { pages };
}
