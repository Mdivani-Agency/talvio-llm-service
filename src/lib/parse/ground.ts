/*
 * Grounding (design §9): a value the model reports is kept only when it can be found in the
 * source text, and the result points at where. Matching is exact first, then tolerant of
 * whitespace and case only; it never fuzzes words, so a paraphrase or an invented value does not
 * match and is reported instead.
 */

export type Span = { start: number; end: number };

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class SourceText {
  private readonly lower: string;

  constructor(readonly text: string) {
    this.lower = text.toLowerCase();
  }

  /** First occurrence at or after `from`, else the first anywhere; null when absent. */
  find(value: string | null, from = 0): Span | null {
    if (value === null) return null;
    const needle = value.trim();
    if (needle.length === 0) return null;
    const exact = this.indexAfter(needle, from, false);
    if (exact) return exact;
    const folded = this.indexAfter(needle.toLowerCase(), from, true);
    if (folded) return folded;
    const words = needle.split(/\s+/).filter(Boolean).map(escape);
    if (words.length < 2) return null;
    const pattern = new RegExp(words.join('\\s+'), 'gi');
    return this.regexAfter(pattern, from);
  }

  slice(span: Span): string {
    return this.text.slice(span.start, span.end).replace(/\s+/g, ' ').trim();
  }

  private indexAfter(needle: string, from: number, folded: boolean): Span | null {
    const haystack = folded ? this.lower : this.text;
    let at = haystack.indexOf(needle, from);
    if (at < 0 && from > 0) at = haystack.indexOf(needle);
    return at < 0 ? null : { start: at, end: at + needle.length };
  }

  private regexAfter(pattern: RegExp, from: number): Span | null {
    pattern.lastIndex = from;
    let match = pattern.exec(this.text);
    if (!match && from > 0) {
      pattern.lastIndex = 0;
      match = pattern.exec(this.text);
    }
    return match ? { start: match.index, end: match.index + match[0].length } : null;
  }
}

/** Characters of `text` not inside any span, as lines worth reporting (long enough to be content). */
export function uncoveredLines(text: string, spans: Span[], minLetters = 25): Span[] {
  const covered = new Uint8Array(text.length);
  for (const span of spans) covered.fill(1, span.start, span.end);
  const lines: Span[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === '\n') {
      const line = text.slice(start, i);
      const letters = line.replace(/[^\p{L}]/gu, '').length;
      if (letters >= minLetters && !covered.subarray(start, i).some((c) => c === 1)) {
        lines.push({ start, end: i });
      }
      start = i + 1;
    }
  }
  return lines;
}
