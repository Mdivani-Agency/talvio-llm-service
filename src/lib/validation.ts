import type { z } from 'zod';

import { ApiError, type ErrorIssue } from './errors';

/**
 * Validates input against a contract schema. Issues report the path and a generic message per
 * issue kind; Zod's own messages are not passed through because some quote the received value.
 */
const ISSUE_MESSAGES: Record<string, string> = {
  invalid_type: 'Wrong type or missing.',
  too_big: 'Too long or too large.',
  too_small: 'Too short or too small.',
  invalid_format: 'Wrong format.',
  invalid_value: 'Not an allowed value.',
  invalid_union: 'Does not match any allowed shape.',
  unrecognized_keys: 'Unknown field.',
  custom: 'Not valid.',
};

export function issuesOf(error: z.ZodError): ErrorIssue[] {
  return error.issues.slice(0, 50).map((issue) => ({
    path: issue.path.map(String).join('.').slice(0, 200) || '(root)',
    message: ISSUE_MESSAGES[issue.code] ?? 'Not valid.',
  }));
}

export function parseWith<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError('invalid_request', { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}
