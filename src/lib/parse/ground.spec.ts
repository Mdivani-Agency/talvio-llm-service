import { SourceText, uncoveredLines } from './ground';

describe('SourceText', () => {
  const source = new SourceText('Senior  Engineer at Acme\nACME Corp\nSenior Engineer again');

  it('finds exact text, then text differing only in case or whitespace', () => {
    expect(source.find('Acme')).toEqual({ start: 20, end: 24 });
    expect(source.find('acme corp')).toEqual({ start: 25, end: 34 });
    expect(source.slice(source.find('Senior Engineer')!)).toBe('Senior Engineer');
  });

  it('finds the occurrence closest to a span, before or after it', () => {
    const text = 'Senior Engineer\n\nAcme — Senior Engineer\n\nGlobex\nSenior Engineer';
    const near = new SourceText(text);
    const acme = { start: text.indexOf('Acme'), end: text.indexOf('Acme') + 4 };
    expect(near.findNear('Senior Engineer', acme)?.start).toBe(text.indexOf('Senior', 18));
    const globex = { start: text.indexOf('Globex'), end: text.indexOf('Globex') + 6 };
    expect(near.findNear('senior engineer', globex)?.start).toBe(text.lastIndexOf('Senior'));
    expect(near.findNear('Lead', acme)).toBeNull();
  });

  it('prefers the occurrence after a position', () => {
    expect(source.find('Senior Engineer', 30)?.start).toBe(35);
  });

  it('never matches paraphrases or invented values', () => {
    expect(source.find('Sr. Engineer')).toBeNull();
    expect(source.find('Globex')).toBeNull();
    expect(source.find('   ')).toBeNull();
    expect(source.find(null)).toBeNull();
  });
});

describe('uncoveredLines', () => {
  it('lists content lines no span touches, ignoring short headings', () => {
    const text =
      'EXPERIENCE\nBuilt the billing platform for 40 teams\nLed the migration to Postgres';
    const covered = { start: text.indexOf('Led'), end: text.length };
    const lines = uncoveredLines(text, [covered]);
    expect(lines.map((line) => text.slice(line.start, line.end))).toEqual([
      'Built the billing platform for 40 teams',
    ]);
  });

  it('lists a partly quoted line when what was left out is content', () => {
    const text = 'Acme Corp — rebuilt the billing platform used by forty teams\nAcme Corp — Lead';
    const company = { start: 0, end: 9 };
    const second = { start: text.lastIndexOf('Acme'), end: text.length };
    const lines = uncoveredLines(text, [company, second]);
    expect(lines.map((line) => text.slice(line.start, line.end))).toEqual([
      'Acme Corp — rebuilt the billing platform used by forty teams',
    ]);
  });
});
