import { z } from 'zod';

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
     * Where jobs, sessions and documents live. `unconfigured` answers every store call with
     * 503 until the DynamoDB store lands (MDI-214). `memory` is for local runs and tests only.
     */
    STORE_DRIVER: z.enum(['unconfigured', 'memory']).default('unconfigured'),
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
