import { RejectedDocumentError } from './errors';
import { EXTRACTOR_VERSION as TEXT_VERSION, normalizeText } from './text';
import { isOle, isZip, listEntries, readEntries } from './zip';

/*
 * DOCX text extraction (design §8). The container is judged before it is read (zip.ts), the XML is
 * scanned with a fixed tag grammar rather than a general parser (so a DOCTYPE or entity can never
 * expand), and nothing is executed or fetched: macros, ActiveX and external content relationships
 * reject the file; hyperlinks keep their text and drop their targets. Images, drawings and embedded
 * objects are inventoried, never read, and reported as warnings instead of being silently dropped.
 */

export const DOCX_EXTRACTOR_VERSION = `docx-1+${TEXT_VERSION}`;

export type DocxWarning = { code: string; message: string };

export type DocxExtraction = {
  text: string;
  extractorVersion: string;
  paragraphs: number;
  tables: number;
  warnings: DocxWarning[];
};

const decode = new TextDecoder('utf-8', { fatal: false });
const OLE_ENCRYPTED = Buffer.from('EncryptedPackage', 'utf16le');

const PART = /^word\/(header|footer)\d*\.xml$/i;

const wanted = (name: string) =>
  name === '[Content_Types].xml' ||
  name === 'word/document.xml' ||
  name === 'word/_rels/document.xml.rels' ||
  PART.test(name);

const UNSAFE_RELATIONSHIPS =
  /\/(attachedTemplate|oleObject|subDocument|frame|externalLink|package)$/i;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, body: string) => {
    if (body[0] !== '#') return ENTITIES[body.toLowerCase()] ?? '';
    const code =
      body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

const TOKEN =
  /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)\b[^>]*\/>|<w:noBreakHyphen\s*\/>|<\/w:p>|<\/w:tc>|<\/w:tr>/g;

/** Text of a WordprocessingML part, read with a fixed tag grammar. */
function textOf(xml: string): string {
  const token = new RegExp(TOKEN.source, 'g');
  let out = '';
  for (let match = token.exec(xml); match; match = token.exec(xml)) {
    const tag = match[0];
    if (match[1] !== undefined) out += decodeEntities(match[1]);
    else if (tag.startsWith('<w:tab')) out += '\t';
    else if (tag.startsWith('<w:noBreakHyphen')) out += '-';
    else if (tag.startsWith('<w:br') || tag.startsWith('<w:cr')) out += '\n';
    else if (tag === '</w:p>') out += '\n';
    else if (tag === '</w:tc>') out += '\t';
    else out += '\n'; // </w:tr>
  }
  return out.replace(/\t+\n/g, '\n');
}

const count = (value: string, pattern: RegExp) => value.match(pattern)?.length ?? 0;

export function extractDocx(bytes: Uint8Array): DocxExtraction {
  if (isOle(bytes)) {
    throw new RejectedDocumentError(
      Buffer.from(bytes).includes(OLE_ENCRYPTED) ? 'encrypted' : 'not_docx',
    );
  }
  if (!isZip(bytes)) throw new RejectedDocumentError('not_docx');

  const entries = listEntries(bytes);
  const names = entries.map((entry) => entry.name);
  if (!names.includes('[Content_Types].xml') || !names.includes('word/document.xml')) {
    throw new RejectedDocumentError('not_docx');
  }
  if (
    names.some((name) => /(^|\/)vbaProject\.bin$/i.test(name) || /^word\/activeX\//i.test(name))
  ) {
    throw new RejectedDocumentError('unsafe');
  }

  const files = readEntries(bytes, entries, wanted);
  const read = (name: string) => decode.decode(files.get(name) ?? new Uint8Array());
  const contentTypes = read('[Content_Types].xml');
  const rels = read('word/_rels/document.xml.rels');
  const xml = read('word/document.xml');

  if (/macroEnabled/i.test(contentTypes)) throw new RejectedDocumentError('unsafe');
  for (const rel of rels.match(/<Relationship\b[^>]*>/gi) ?? []) {
    const type = /\bType="([^"]*)"/i.exec(rel)?.[1] ?? '';
    const external = /\bTargetMode="External"/i.test(rel);
    const hyperlink = /\/hyperlink$/i.test(type);
    if (UNSAFE_RELATIONSHIPS.test(type) || (external && !hyperlink)) {
      throw new RejectedDocumentError('unsafe');
    }
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<w:document\b/.test(xml)) {
    throw new RejectedDocumentError(/<!DOCTYPE|<!ENTITY/i.test(xml) ? 'unsafe' : 'not_docx');
  }

  // A text box appears twice in mc:AlternateContent (the modern shape and its fallback): read one.
  const body = xml.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '');

  // Headers come first and footers last; identical parts (default, first-page, even-page copies) count once.
  const partText = (kind: 'header' | 'footer') => {
    const seen = new Set<string>();
    for (const name of [...files.keys()]
      .filter((n) => PART.test(n) && n.toLowerCase().includes(kind))
      .sort()) {
      const raw = read(name);
      if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new RejectedDocumentError('unsafe');
      seen.add(textOf(raw.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '')).trim());
    }
    return [...seen].filter(Boolean);
  };
  const headers = partText('header');
  const footers = partText('footer');
  const bodyText = textOf(body);
  const out = [...headers, bodyText, ...footers].join('\n\n');

  const warnings: DocxWarning[] = [];
  const images = names.filter((name) => /^word\/media\//i.test(name)).length;
  if (images > 0) {
    warnings.push({
      code: 'docx_images_not_read',
      message: `${images} image${images === 1 ? ' was' : 's were'} not read. Export the document as PDF if images carry content.`,
    });
  }
  if (names.some((name) => /^word\/embeddings\//i.test(name)) || /<w:object\b/.test(body)) {
    warnings.push({
      code: 'docx_embedded_objects_not_read',
      message: 'Embedded objects were not read. Export the document as PDF if they carry content.',
    });
  }
  if (/<w:txbxContent\b/.test(body)) {
    warnings.push({
      code: 'docx_text_boxes_inline',
      message:
        'Text boxes were read in place, so their position in the text may differ from the page.',
    });
  }

  return {
    text: normalizeText(out),
    extractorVersion: DOCX_EXTRACTOR_VERSION,
    paragraphs: count(body, /<\/w:p>/g),
    tables: count(body, /<w:tbl>/g),
    warnings,
  };
}
