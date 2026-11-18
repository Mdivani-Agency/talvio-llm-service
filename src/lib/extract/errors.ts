/*
 * Why a file cannot be used, in terms a person can act on. The `reason` is stable; the message is
 * fixed text and never echoes file content or names. Document records map `reason` to the
 * contract's rejection codes.
 */

export type RejectReason =
  | 'not_docx'
  | 'malformed'
  | 'encrypted'
  | 'unsafe'
  | 'too_large'
  | 'too_long'
  | 'empty'
  | 'checksum_mismatch'
  | 'unsupported_type'
  | 'ocr_page_limit';

const MESSAGES: Record<RejectReason, string> = {
  not_docx: 'The file is not a valid DOCX document. Save it as DOCX or PDF and upload it again.',
  malformed: 'The file is not a valid document of the type it was declared as. Upload it again.',
  encrypted: 'The file is password-protected. Remove the password and upload it again.',
  unsafe:
    'The file contains macros, external content or an unsafe structure. Export it as a plain DOCX or PDF.',
  too_large: 'The file is larger than the service allows after unpacking.',
  too_long: 'The document has more text than the 100,000 character limit.',
  empty: 'No readable text was found in the document.',
  checksum_mismatch: 'The uploaded file does not match what was declared.',
  unsupported_type: 'Upload a PDF or DOCX file.',
  ocr_page_limit: 'More than 3 pages need OCR, which is the limit.',
};

export class RejectedDocumentError extends Error {
  constructor(readonly reason: RejectReason) {
    super(MESSAGES[reason]);
    this.name = 'RejectedDocumentError';
  }
}

export const rejectionMessage = (reason: RejectReason): string => MESSAGES[reason];
