import { createHash } from 'crypto';

import { canonicalJson } from '@talvio/llm-contracts';

/** sha256 over canonical JSON: equal for equal content regardless of key order. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
