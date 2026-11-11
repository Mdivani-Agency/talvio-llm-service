/*
 * Grounding (design §9): a value the model reports is kept only when it can be found in the
 * source text, and the result points at where. Matching is exact first, then tolerant of
 * whitespace and case only; it never fuzzes words, so a paraphrase or an invented value does not
 * match and is reported instead.
 */

export type Span = { start: number; end: number };

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LETTER = /\p{L}/u;
/** Occurrences compared by `findNear`; a resume repeating a value more often is not plausible. */
const MAX_OCCURRENCES = 50;

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

  /**
   * The occurrence of `needle` closest to `near` (fewest lines apart, then fewest characters), so
   * a job title is read beside its company and not from a headline that repeats it. Null when
   * there is none.
   */
  findNear(needle: string, near: Span): Span | null {
    // Lines apart first, then characters: the same line beats a closer line above.
    const distance = (span: Span) => {
      const [a, b] = span.end <= near.start ? [span.end, near.start] : [near.end, span.start];
      if (b <= a) return [0, 0] as const;
      const gap = this.text.slice(a, b);
      return [gap.split('\n').length - 1, gap.length] as const;
    };
    const closer = (x: Span, y: Span) => {
      const [dx, dy] = [distance(x), distance(y)];
      return dx[0] !== dy[0] ? dx[0] < dy[0] : dx[1] < dy[1];
    };
    let best = this.find(needle, 0);
    if (!best) return null;
    for (let n = 0, from = best.start + 1; n < MAX_OCCURRENCES; n += 1) {
      const next = this.find(needle, from);
      if (!next || next.start < from) break;
      if (closer(next, best)) best = next;
      from = next.start + 1;
    }
    return best;
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

/**
 * Lines of `text` holding at least `minLetters` letters that are inside no span. Counting the
 * uncovered letters, not whether the line is touched at all, means a line whose company was quoted
 * but whose sentence was dropped is still reported.
 */

export function uncoveredLines(text: string, spans: Span[], minLetters = 25): Span[] {
  const covered = new Uint8Array(text.length);
  for (const span of spans) covered.fill(1, span.start, span.end);
  const lines: Span[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === '\n') {
      let letters = 0;
      for (let j = start; j < i; j += 1) {
        if (!covered[j] && LETTER.test(text[j]!)) letters += 1;
      }
      if (letters >= minLetters) {
        lines.push({ start, end: i });
      }
      start = i + 1;
    }
  }
  return lines;
}
