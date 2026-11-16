import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/*
 * Secrets read at run time (MDI-638). A secret lives in an SSM SecureString that an owner creates
 * and fills in; Terraform only grants read access to it. Only its name is configured, so the value
 * never sits in the Lambda environment, the deployment package, CloudFormation or Terraform state.
 * Errors carry the error name only.
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
      value = out.Parameter?.Value?.trim();
    } catch {
      // Missing parameter, no access, throttling: the caller retries; the cause is not logged.
      throw new SecretUnavailableError();
    }
    if (!value) throw new SecretUnavailableError();
    return value;
  };
}
