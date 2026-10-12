import { z } from 'zod';

/**
 * Contract version carried by every request and result as `schemaVersion`.
 * - A new minor version only adds optional fields, enum members a client can ignore, or
 *   operations. The service accepts every minor version of the same major.
 * - A breaking change creates a new major version and a new base path (`/llm/v2`).
 * See docs/contracts.md (Versioning and compatibility).
 */
export const SCHEMA_VERSION = '1.0' as const;
export const SUPPORTED_SCHEMA_VERSIONS = ['1.0'] as const;
export const API_BASE_PATH = '/llm/v1' as const;

export const schemaVersionSchema = z.enum(SUPPORTED_SCHEMA_VERSIONS);
export type SchemaVersion = z.infer<typeof schemaVersionSchema>;
