import { z } from 'zod';

import { LIMITS } from './limits';

/** Server-issued identifiers (jobs, documents, sessions, context revisions). */
export const uuidSchema = z.uuid();

/**
 * Stable identifier of an entity, question, fact, change or requirement inside one document or
 * result. Persisted entities use their row UUID; new entities use a prefixed key such as
 * `parsed:experience:0`. Never a positional index on its own.
 */
export const stableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/);

/** Lowercase hex SHA-256 of canonical JSON or raw bytes. */
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** Opaque revision token of a canonical profile or resume (today the row's updated_at). */
export const revisionSchema = z.string().min(1).max(64);

export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * A calendar date with its known precision: `2024`, `2024-03` or `2024-03-15`.
 * A missing date is `null`, never a guessed day or month.
 */
export const partialDateSchema = z
  .string()
  .regex(/^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/)
  .refine(isCalendarDate, { message: 'not a calendar date' });

/** Rejects days that do not exist in their month, such as 2023-02-29 or 2024-04-31. */
function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  if (day === undefined || month === undefined || year === undefined) {
    return true;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** BCP 47 tag that controls formatting, e.g. `en-US`. */
export const localeSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/)
  .default('en-US');

export const idempotencyKeySchema = z
  .string()
  .min(LIMITS.idempotencyKeyMinChars)
  .max(LIMITS.idempotencyKeyMaxChars)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const shortTextSchema = z.string().max(LIMITS.shortTextChars);
export const longTextSchema = z.string().max(LIMITS.longTextChars);

/** Ids that appear more than once, in first-seen order. */
export function duplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  return [...duplicates];
}

export type StableId = z.infer<typeof stableIdSchema>;
export type PartialDate = z.infer<typeof partialDateSchema>;
