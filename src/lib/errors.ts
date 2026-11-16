import { HTTP_ERROR_STATUS, HttpErrorCode } from '@talvio/llm-contracts';

/** Messages users see. They never contain input values, tokens or internal details. */
const DEFAULT_MESSAGES: Record<HttpErrorCode, string> = {
  invalid_request: 'The request is not valid.',
  idempotency_key_required: 'An Idempotency-Key header is required.',
  unauthorized: 'Sign in to use AI features.',
  not_found: 'Not found.',
  stale_context: 'This was made for an older version. Refresh and try again.',
  idempotency_conflict: 'This Idempotency-Key was already used for a different request.',
  invalid_retry: 'This job cannot be retried.',
  payload_too_large: 'The request is too large.',
  unsupported_media_type: 'This file type is not supported.',
  unusable_document: 'This document cannot be used.',
  ocr_page_limit: 'Too many pages need text recognition.',
  budget_exceeded_preflight: 'This request is too large to process.',
  unsupported_language: 'This language is not supported yet.',
  quota_exceeded: 'You have reached today’s AI limit.',
  dependency_unavailable: 'AI features are temporarily unavailable. Try again later.',
  internal_error: 'Something went wrong.',
};

const RETRYABLE: ReadonlySet<HttpErrorCode> = new Set([
  'quota_exceeded',
  'dependency_unavailable',
  'internal_error',
]);

export type ErrorIssue = { path: string; message: string };

export class ApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly issues?: ErrorIssue[];
  readonly headers: Record<string, string>;

  constructor(
    readonly code: HttpErrorCode,
    options: { message?: string; issues?: ErrorIssue[]; headers?: Record<string, string> } = {},
  ) {
    super(options.message ?? DEFAULT_MESSAGES[code]);
    this.name = 'ApiError';
    this.status = HTTP_ERROR_STATUS[code];
    this.retryable = RETRYABLE.has(code);
    this.issues = options.issues;
    this.headers = options.headers ?? {};
  }
}

export const notFound = () => new ApiError('not_found');
export const unauthorized = (message?: string) => new ApiError('unauthorized', { message });
