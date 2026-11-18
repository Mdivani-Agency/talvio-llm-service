import { unzipSync } from 'fflate';

import { RejectedDocumentError } from './errors';

/*
 * A bounded reader for ZIP containers (DOCX). The central directory is read first, without
 * inflating anything, so entry count, declared sizes, encryption and path tricks are judged before
 * a byte is decompressed. Only the entries the caller asks for are inflated, and the inflated size
 * must equal what the directory declared, so a lying header cannot buy more memory.
 */

export const ZIP_LIMITS = {
  entries: 500,
  /** Declared uncompressed size of any one entry that is read. */
  entryBytes: 8 * 1024 * 1024,
  /** Declared uncompressed size of everything in the archive. */
  totalBytes: 40 * 1024 * 1024,
  /** Uncompressed to compressed ratio of any one entry. */
  ratio: 200,
} as const;

export type ZipEntry = {
  name: string;
  compressedSize: number;
  size: number;
  encrypted: boolean;
};

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

const decoder = new TextDecoder('utf-8', { fatal: false });

/** True for the magic of a ZIP local header. */
export const isZip = (bytes: Uint8Array) =>
  bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;

/** True for the magic of an OLE compound file, which is how password-protected Office files are stored. */
export const isOle = (bytes: Uint8Array) =>
  bytes.length > 8 &&
  bytes[0] === 0xd0 &&
  bytes[1] === 0xcf &&
  bytes[2] === 0x11 &&
  bytes[3] === 0xe0;

/** The entries named by the central directory. Throws RejectedDocumentError for anything unsafe. */
export function listEntries(bytes: Uint8Array): ZipEntry[] {
  const notDocx = () => new RejectedDocumentError('not_docx');
  const scanFrom = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= scanFrom; i -= 1) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notDocx();
  const count = u16(bytes, eocd + 10);
  const dirSize = u32(bytes, eocd + 12);
  const dirOffset = u32(bytes, eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new RejectedDocumentError('unsafe'); // ZIP64
  if (count > ZIP_LIMITS.entries) throw new RejectedDocumentError('unsafe');
  if (dirOffset + dirSize > eocd) throw notDocx();

  const entries: ZipEntry[] = [];
  let total = 0;
  let o = dirOffset;
  for (let i = 0; i < count; i += 1) {
    if (o + 46 > bytes.length || u32(bytes, o) !== 0x02014b50) throw notDocx();
    const flags = u16(bytes, o + 8);
    const compressedSize = u32(bytes, o + 20);
    const size = u32(bytes, o + 24);
    const nameLength = u16(bytes, o + 28);
    const extraLength = u16(bytes, o + 30);
    const commentLength = u16(bytes, o + 32);
    const name = decoder.decode(bytes.subarray(o + 46, o + 46 + nameLength));
    o += 46 + nameLength + extraLength + commentLength;

    if (name.startsWith('/') || name.includes('..') || name.includes('\\') || name.includes('\0')) {
      throw new RejectedDocumentError('unsafe');
    }
    if (flags & 1) throw new RejectedDocumentError('encrypted');
    total += size;
    if (total > ZIP_LIMITS.totalBytes) throw new RejectedDocumentError('too_large');
    if (size > 0 && compressedSize > 0 && size / compressedSize > ZIP_LIMITS.ratio) {
      throw new RejectedDocumentError('unsafe');
    }
    entries.push({ name, compressedSize, size, encrypted: false });
  }
  return entries;
}

/** Inflates only the named entries. Missing names are simply absent from the result. */
export function readEntries(
  bytes: Uint8Array,
  entries: ZipEntry[],
  wanted: (name: string) => boolean,
): Map<string, Uint8Array> {
  const declared = new Map(entries.map((entry) => [entry.name, entry.size]));
  let data: Record<string, Uint8Array>;
  try {
    data = unzipSync(bytes, {
      filter: (file) => {
        if (!wanted(file.name)) return false;
        if (file.originalSize > ZIP_LIMITS.entryBytes) {
          throw new RejectedDocumentError('too_large');
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof RejectedDocumentError) throw error;
    throw new RejectedDocumentError('not_docx');
  }
  const out = new Map<string, Uint8Array>();
  for (const [name, content] of Object.entries(data)) {
    if (content.length !== declared.get(name)) throw new RejectedDocumentError('unsafe');
    out.set(name, content);
  }
  return out;
}
