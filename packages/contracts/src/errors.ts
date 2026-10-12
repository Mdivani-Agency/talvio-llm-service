import { z } from 'zod';

/*
 * Stable error codes (design §6). Messages are safe for users; they never contain provider
 * payloads, personal content, tokens or stack traces. Every error carries a correlation id
 * the user can quote to support.
 */

/** Synchronous HTTP errors and their status codes. */
export const HTTP_ERROR_STATUS = {
  invalid_request: 400,
  idempotency_key_required: 400,
  unauthorized: 401,
  /** Absent, revoked or owned by someone else: indistinguishable on purpose. */
  not_found: 404,
  stale_context: 409,
  idempotency_conflict: 409,
  invalid_retry: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  unusable_document: 422,
  ocr_page_limit: 422,
  budget_exceeded_preflight: 422,
  unsupported_language: 422,
  quota_exceeded: 429,
  dependency_unavailable: 503,
  internal_error: 500,
} as const;

export type HttpErrorCode = keyof typeof HTTP_ERROR_STATUS;
export const httpErrorCodeEnum = z.enum(
  Object.keys(HTTP_ERROR_STATUS) as [HttpErrorCode, ...HttpErrorCode[]],
);

/** Reasons an accepted job ends without a result. */
export const JOB_ERROR_CODES = [
  'budget_exceeded',
  'input_policy_blocked',
  'unsupported_language',
  'unusable_document',
  'ocr_page_limit',
  'validation_failed',
  'model_refusal',
  'output_truncated',
  'dependency_unavailable',
  'deadline_exceeded',
  'cancelled',
  'revoked',
  'internal_error',
] as const;
export const jobErrorCodeEnum = z.enum(JOB_ERROR_CODES);
export type JobErrorCode = z.infer<typeof jobErrorCodeEnum>;

/** Which job errors a client may retry with POST /jobs/{id}/retry before the deadline. */
export const RETRYABLE_JOB_ERRORS: readonly JobErrorCode[] = [
  'dependency_unavailable',
  'internal_error',
];

export const errorBodySchema = z.strictObject({
  error: z.strictObject({
    code: httpErrorCodeEnum,
    message: z.string().max(500),
    retryable: z.boolean(),
    correlationId: z.string().min(1).max(128),
    /** Field paths for invalid_request; never input values. */
    issues: z
      .array(z.strictObject({ path: z.string().max(200), message: z.string().max(200) }))
      .max(50)
      .optional(),
  }),
});

export const jobErrorSchema = z.strictObject({
  code: jobErrorCodeEnum,
  message: z.string().max(500),
  retryable: z.boolean(),
  correlationId: z.string().min(1).max(128),
});

export type ErrorBody = z.infer<typeof errorBodySchema>;
export type JobError = z.infer<typeof jobErrorSchema>;
