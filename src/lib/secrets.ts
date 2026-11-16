import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/*
 * Secrets read at run time (MDI-638). A secret lives in an SSM SecureString that Terraform creates
 * and an owner fills in; only its name is configured, so the value never sits in the Lambda
 * environment, the deployment package or CloudFormation. Errors carry the error name only.
 */

export class SecretUnavailableError extends Error {
  constructor() {
    super('secret unavailable');
    this.name = 'SecretUnavailableError';
  }
}

/** Reads a SecureString parameter, decrypted. Each call reads again; callers keep the value. */
export function ssmSecret(name: string, client?: Pick<SSMClient, 'send'>): () => Promise<string> {
  const ssm = client ?? new SSMClient({ maxAttempts: 2 });
  return async () => {
    let value: string | undefined;
    try {
      const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      value = out.Parameter?.Value;
    } catch {
      throw new SecretUnavailableError();
    }
    // Terraform seeds a placeholder until the owner sets the real value.
    if (!value || value === PLACEHOLDER) throw new SecretUnavailableError();
    return value;
  };
}

/** Value Terraform writes when it creates the parameter; never a usable key. */
export const PLACEHOLDER = 'unset';
