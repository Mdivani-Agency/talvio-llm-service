import { z } from 'zod';

import { DEFAULT_ACCOUNT_DAILY_CEILING_MICRO_USD } from './limits';

/*
 * Runtime configuration, validated once per cold start. Errors name the variables that are
 * wrong, never their values.
 */

const configSchema = z
  .object({
    STAGE: z.enum(['local', 'test', 'dev', 'prod']),
    /** Supabase project URL; the JWT issuer is `${SUPABASE_URL}/auth/v1`. */
    SUPABASE_URL: z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, '')),
    SUPABASE_JWT_AUDIENCE: z.string().min(1).default('authenticated'),
    /** Asymmetric Supabase signing keys only; the legacy shared HS256 secret is never accepted. */
    SUPABASE_JWT_ALGORITHMS: z
      .string()
      .default('ES256,RS256')
      .transform((value) => value.split(',').map((item) => item.trim()))
      .pipe(z.array(z.enum(['ES256', 'RS256', 'EdDSA'])).min(1)),
    /**
     * Where jobs, sessions and documents live. `dynamodb` is the deployed store and needs the
     * four table names. `unconfigured` answers every store call with 503. `memory` is for local
     * runs and tests only.
     */
    STORE_DRIVER: z.enum(['unconfigured', 'memory', 'dynamodb']).default('unconfigured'),
    /** Terraform-owned tables, read from SSM /<stage>/dynamodb/llm-* by serverless.ts. */
    LLM_JOBS_TABLE: z.string().min(1).optional(),
    LLM_SESSIONS_TABLE: z.string().min(1).optional(),
    LLM_QUOTAS_TABLE: z.string().min(1).optional(),
    LLM_OUTBOX_TABLE: z.string().min(1).optional(),
    /** Release new jobs are pinned to; its queue, DLQ and executables finish them (design §8). */
    PIPELINE_RELEASE: z
      .string()
      .regex(/^[a-z0-9]+$/)
      .default('v1'),
    /** JSON object of release id to work queue URL, read from SSM /<stage>/llm/work-queue-url-<release>. */
    WORK_QUEUE_URLS: z
      .string()
      .optional()
      .transform((value, ctx) => {
        if (value === undefined) return undefined;
        try {
          return z.record(z.string(), z.url()).parse(JSON.parse(value));
        } catch {
          ctx.addIssue({ code: 'custom', message: 'WORK_QUEUE_URLS must map release ids to URLs' });
          return z.NEVER;
        }
      }),
    /** Terraform-owned private buckets, read from SSM /<stage>/s3/llm-{quarantine,artifacts}. */
    LLM_QUARANTINE_BUCKET: z.string().min(1).optional(),
    LLM_ARTIFACTS_BUCKET: z.string().min(1).optional(),
    /**
     * Upload content types read by OCR instead of deterministic extraction. Empty by default: the
     * ticket sends PDFs to the browser and DOCX to the deterministic path, so nothing is sent to
     * Textract until a type is listed here.
     */
    OCR_CONTENT_TYPES: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    /** SNS topic and role Textract publishes completion with, from SSM /<stage>/llm/ocr-topic-arn and textract-role-arn. */
    OCR_TOPIC_ARN: z.string().min(1).optional(),
    OCR_ROLE_ARN: z.string().min(1).optional(),
    /** DynamoDB Local for CI and local runs. Refused on deployed stages. */
    DYNAMODB_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
    /** Account-wide spend ceiling per UTC day, in micro-USD. */
    ACCOUNT_DAILY_CEILING_MICRO_USD: z.coerce
      .number()
      .int()
      .min(0)
      .default(DEFAULT_ACCOUNT_DAILY_CEILING_MICRO_USD),
    /** Largest JSON request body accepted, in bytes. */
    MAX_BODY_BYTES: z.coerce.number().int().min(1_024).max(6_000_000).default(1_000_000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .refine(
    (config) => config.STORE_DRIVER !== 'memory' || ['local', 'test'].includes(config.STAGE),
    {
      message: 'the memory store is only allowed on local and test stages',
      path: ['STORE_DRIVER'],
    },
  )
  .refine(
    (config) =>
      config.STORE_DRIVER !== 'dynamodb' ||
      [
        config.LLM_JOBS_TABLE,
        config.LLM_SESSIONS_TABLE,
        config.LLM_QUOTAS_TABLE,
        config.LLM_OUTBOX_TABLE,
      ].every(Boolean),
    {
      message:
        'the dynamodb store needs LLM_JOBS_TABLE, LLM_SESSIONS_TABLE, LLM_QUOTAS_TABLE and LLM_OUTBOX_TABLE',
      path: ['STORE_DRIVER'],
    },
  )
  .refine(
    (config) =>
      config.WORK_QUEUE_URLS
        ? config.PIPELINE_RELEASE in config.WORK_QUEUE_URLS
        : config.STORE_DRIVER !== 'dynamodb' || config.STAGE === 'local' || config.STAGE === 'test',
    {
      message:
        'WORK_QUEUE_URLS needs an entry for PIPELINE_RELEASE (required for the dynamodb store outside local and test)',
      path: ['WORK_QUEUE_URLS'],
    },
  )
  .refine(
    (config) =>
      config.STORE_DRIVER !== 'dynamodb' ||
      config.STAGE === 'local' ||
      config.STAGE === 'test' ||
      Boolean(config.LLM_QUARANTINE_BUCKET && config.LLM_ARTIFACTS_BUCKET),
    {
      message: 'deployed stages need LLM_QUARANTINE_BUCKET and LLM_ARTIFACTS_BUCKET',
      path: ['LLM_QUARANTINE_BUCKET'],
    },
  )
  .refine(
    (config) =>
      config.OCR_CONTENT_TYPES.length === 0 || Boolean(config.OCR_TOPIC_ARN && config.OCR_ROLE_ARN),
    {
      message: 'OCR_CONTENT_TYPES needs OCR_TOPIC_ARN and OCR_ROLE_ARN',
      path: ['OCR_CONTENT_TYPES'],
    },
  )
  .refine((config) => !config.DYNAMODB_ENDPOINT || ['local', 'test'].includes(config.STAGE), {
    message: 'DYNAMODB_ENDPOINT is only allowed on local and test stages',
    path: ['DYNAMODB_ENDPOINT'],
  })
  .refine(
    (config) =>
      config.STAGE === 'local' ||
      config.STAGE === 'test' ||
      config.SUPABASE_URL.startsWith('https://'),
    {
      message: 'SUPABASE_URL must use https outside local and test stages',
      path: ['SUPABASE_URL'],
    },
  );

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(readonly variables: string[]) {
    super(`Invalid configuration: ${variables.join(', ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const variables = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'config'))),
    ];
    throw new ConfigError(variables.sort());
  }
  return parsed.data;
}
