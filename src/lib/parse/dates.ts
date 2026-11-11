/*
 * Deterministic reading of date text the model quoted from the source (design §5: no guessed
 * dates). The model never produces a normalized date; it copies "Mar 2020" or "Present" and this
 * code decides what that text says. Anything it cannot read for certain stays null and is
 * reported, never completed with a default day, month or "current".
 */

export type ReadDate =
  /** A calendar value at the precision the text states. */
  | { kind: 'date'; value: string; precision: 'year' | 'month' | 'day' }
  /** "Present", "Current", "Now": an ongoing role or study. */
  | { kind: 'present' }
  /** Text that names no readable date, or one that is ambiguous (e.g. 03/04/2020). */
  | { kind: 'unknown' };

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const PRESENT =
  /^(present|current|currently|now|today|ongoing|to date|till date|until now|დღემდე)$/i;
const SEASON = /^(spring|summer|autumn|fall|winter)\s+/i;

const pad = (n: number) => String(n).padStart(2, '0');
const year = (text: string) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= 1900 && value <= 2100 ? value : null;
};
const validDay = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

export function readDate(raw: string | null): ReadDate {
  if (raw === null) return { kind: 'unknown' };
  const text = raw.trim().replace(/\s+/g, ' ').replace(/[.,]$/, '');
  if (PRESENT.test(text)) return { kind: 'present' };

  // A season names a year but no month.
  const plain = text.replace(SEASON, '');
  let match = /^(\d{4})$/.exec(plain);
  if (match) {
    const y = year(match[1]!);
    return y ? { kind: 'date', value: String(y), precision: 'year' } : { kind: 'unknown' };
  }
  if (plain !== text) return { kind: 'unknown' };

  // March 2020, Mar. 2020, Mar '20 is not accepted (two-digit years are ambiguous).
  match = /^([A-Za-z]+)\.?\s+(\d{4})$/.exec(text);
  if (match) {
    const m = MONTHS[match[1]!.toLowerCase()];
    const y = year(match[2]!);
    return m && y
      ? { kind: 'date', value: `${y}-${pad(m)}`, precision: 'month' }
      : { kind: 'unknown' };
  }
  // 2020-03, 2020/03, 2020.03
  match = /^(\d{4})[-/.](\d{1,2})$/.exec(text);
  if (match) {
    const y = year(match[1]!);
    const m = Number(match[2]);
    return y && m >= 1 && m <= 12
      ? { kind: 'date', value: `${y}-${pad(m)}`, precision: 'month' }
      : { kind: 'unknown' };
  }
  // 03/2020, 3.2020, 03-2020
  match = /^(\d{1,2})[-/.](\d{4})$/.exec(text);
  if (match) {
    const m = Number(match[1]);
    const y = year(match[2]!);
    return y && m >= 1 && m <= 12
      ? { kind: 'date', value: `${y}-${pad(m)}`, precision: 'month' }
      : { kind: 'unknown' };
  }
  // ISO 2020-03-15 only: day-first and month-first numeric dates are ambiguous.
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) {
    const y = year(match[1]!);
    const m = Number(match[2]);
    const d = Number(match[3]);
    return y && m >= 1 && m <= 12 && validDay(y, m, d)
      ? { kind: 'date', value: `${y}-${pad(m)}-${pad(d)}`, precision: 'day' }
      : { kind: 'unknown' };
  }
  // 15 March 2020, March 15, 2020
  match = /^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/.exec(text) ?? null;
  const swapped = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (match || swapped) {
    const [d, name, y] = match
      ? [Number(match[1]), match[2]!, year(match[3]!)]
      : [Number(swapped![2]), swapped![1]!, year(swapped![3]!)];
    const m = MONTHS[name.toLowerCase()];
    return m && y && validDay(y, m, d)
      ? { kind: 'date', value: `${y}-${pad(m)}-${pad(d)}`, precision: 'day' }
      : { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}
