import { strToU8, zipSync } from 'fflate';

import { RejectedDocumentError, type RejectReason } from './errors';
import { extractDocx } from './docx';
import { normalizeText } from './text';

const CONTENT_TYPES =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const RELS = (extra = '') =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${extra}</Relationships>`;
const doc = (inner: string) =>
  `<?xml version="1.0"?><w:document xmlns:w="w" xmlns:mc="mc"><w:body>${inner}</w:body></w:document>`;
const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

function docx(inner: string, extra: Record<string, string | Uint8Array> = {}, rels = RELS()) {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    'word/document.xml': strToU8(doc(inner)),
    'word/_rels/document.xml.rels': strToU8(rels),
  };
  for (const [name, content] of Object.entries(extra)) {
    files[name] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(files);
}

const rejects = (bytes: Uint8Array, reason: RejectReason) => {
  try {
    extractDocx(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(RejectedDocumentError);
    expect((error as RejectedDocumentError).reason).toBe(reason);
    return;
  }
  throw new Error('expected a rejection');
};

// Varied text, as real documents are; a run of one letter would look like a zip bomb.
const prose = (length: number) => {
  let seed = 7;
  let out = '';
  while (out.length < length) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out += seed.toString(36);
  }
  return out.slice(0, length);
};

describe('extractDocx', () => {
  it('reads headers and footers, once each, around the body', () => {
    const part = (tag: string, text: string) =>
      `<?xml version="1.0"?><w:${tag} xmlns:w="w">${p(text)}</w:${tag}>`;
    const out = extractDocx(
      docx(p('Body'), {
        'word/header1.xml': part('hdr', 'Nino Beridze nino@example.com'),
        'word/header2.xml': part('hdr', 'Nino Beridze nino@example.com'),
        'word/footer1.xml': part('ftr', 'Page footer'),
      }),
    );
    expect(out.text).toBe('Nino Beridze nino@example.com\n\nBody\n\nPage footer');
  });

  it('reads paragraphs, tabs, breaks and entities in order', () => {
    const result = extractDocx(
      docx(
        p('Nino Beridze') +
          '<w:p><w:r><w:t xml:space="preserve">Backend &amp; Platform</w:t><w:tab/><w:t>2019&#8211;2024</w:t><w:br/><w:t>Tbilisi</w:t></w:r></w:p>',
      ),
    );
    expect(result.text).toBe('Nino Beridze\nBackend & Platform\t2019–2024\nTbilisi');
    expect(result.paragraphs).toBe(2);
    expect(result.extractorVersion).toMatch(/^docx-1/);
    expect(result.warnings).toEqual([]);
  });

  it('keeps table cells and rows apart', () => {
    const cell = (text: string) => `<w:tc>${p(text)}</w:tc>`;
    const result = extractDocx(
      docx(
        `<w:tbl><w:tr>${cell('Role')}${cell('Dates')}</w:tr><w:tr>${cell('Engineer')}${cell('2020')}</w:tr></w:tbl>`,
      ),
    );
    expect(result.tables).toBe(1);
    expect(result.text).toContain('Role');
    expect(result.text.indexOf('Dates')).toBeLessThan(result.text.indexOf('Engineer'));
  });

  it('ignores tracked deletions and reads a text box once', () => {
    const result = extractDocx(
      docx(
        '<w:p><w:del><w:r><w:delText>old claim</w:delText></w:r></w:del><w:r><w:t>kept</w:t></w:r></w:p>' +
          '<mc:AlternateContent><mc:Choice><w:p><w:txbxContent>' +
          p('Boxed') +
          '</w:txbxContent></w:p></mc:Choice><mc:Fallback>' +
          p('Boxed') +
          '</mc:Fallback></mc:AlternateContent>',
      ),
    );
    expect(result.text).not.toContain('old claim');
    expect(result.text.match(/Boxed/g)).toHaveLength(1);
    expect(result.warnings.map((w) => w.code)).toContain('docx_text_boxes_inline');
  });

  it('warns about images and embedded objects instead of dropping them silently', () => {
    const result = extractDocx(
      docx(p('Hello'), { 'word/media/image1.png': 'png', 'word/embeddings/object1.bin': 'x' }),
    );
    expect(result.warnings.map((w) => w.code).sort()).toEqual([
      'docx_embedded_objects_not_read',
      'docx_images_not_read',
    ]);
  });

  it('keeps hyperlink text and ignores its target', () => {
    const rels = RELS(
      '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>',
    );
    expect(extractDocx(docx(p('Portfolio'), {}, rels)).text).toBe('Portfolio');
  });

  it.each([
    ['a macro project', { 'word/vbaProject.bin': 'x' }, RELS()],
    [
      'an external template',
      {},
      RELS(
        '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="http://evil.test/t.dotm" TargetMode="External"/>',
      ),
    ],
    [
      'an external image',
      {},
      RELS(
        '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://evil.test/i.png" TargetMode="External"/>',
      ),
    ],
  ])('rejects %s as unsafe', (_name, extra, rels) => {
    rejects(docx(p('x'), extra, rels), 'unsafe');
  });

  it('rejects a macro-enabled content type and an entity declaration', () => {
    const macro = zipSync({
      '[Content_Types].xml': strToU8(CONTENT_TYPES.replace('main+xml', 'macroEnabled.main+xml')),
      'word/document.xml': strToU8(doc(p('x'))),
    });
    rejects(macro, 'unsafe');
    const xxe = zipSync({
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      'word/document.xml': strToU8(
        '<!DOCTYPE d [<!ENTITY e SYSTEM "file:///etc/passwd">]>' + doc(p('&e;')),
      ),
    });
    rejects(xxe, 'unsafe');
  });

  it('rejects password-protected, legacy and non-zip files', () => {
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from('EncryptedPackage', 'utf16le'),
    ]);
    rejects(new Uint8Array(ole), 'encrypted');
    rejects(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 'not_docx');
    rejects(strToU8('just some text, not a zip'), 'not_docx');
    rejects(zipSync({ 'hello.txt': strToU8('hi') }), 'not_docx');
  });

  it('rejects a zip bomb and path traversal before inflating', () => {
    rejects(docx(p('x'), { 'word/big.bin': new Uint8Array(20 * 1024 * 1024) }), 'unsafe');
    rejects(docx(p('x'), { '../evil.xml': 'x' }), 'unsafe');
  });

  it('rejects empty and over-long text instead of truncating', () => {
    rejects(docx(p('   ')), 'empty');
    rejects(docx(p(prose(100_001))), 'too_long');
    expect(extractDocx(docx(p(prose(100_000)))).text).toHaveLength(100_000);
  });
});

describe('normalizeText', () => {
  it('normalizes line ends, control characters and blank runs', () => {
    expect(normalizeText('a\r\nb \u0000\n\n\n\nc  ')).toBe('a\nb\n\nc');
  });

  it('rejects instead of truncating', () => {
    expect(() => normalizeText('')).toThrow(RejectedDocumentError);
    expect(() => normalizeText('x'.repeat(100_001))).toThrow(RejectedDocumentError);
  });
});
