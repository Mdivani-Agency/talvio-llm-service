import type { SSMClient } from '@aws-sdk/client-ssm';

import { SecretUnavailableError, ssmSecret } from './secrets';

function fake(respond: () => unknown) {
  const sent: Record<string, unknown>[] = [];
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      sent.push(command.input);
      return respond();
    },
  } as unknown as Pick<SSMClient, 'send'>;
  return { client, sent };
}

describe('ssmSecret', () => {
  it('reads the decrypted SecureString by name', async () => {
    const { client, sent } = fake(() => ({ Parameter: { Value: 'sk-ant-1' } }));
    await expect(ssmSecret('/dev/llm/anthropic-api-key', client)()).resolves.toBe('sk-ant-1');
    expect(sent).toEqual([{ Name: '/dev/llm/anthropic-api-key', WithDecryption: true }]);
  });

  it('refuses an empty or missing value', async () => {
    for (const Value of ['', '  ', undefined]) {
      const { client } = fake(() => ({ Parameter: { Value } }));
      await expect(ssmSecret('/dev/x', client)()).rejects.toBeInstanceOf(SecretUnavailableError);
    }
  });

  it('hides the cause of a failed read', async () => {
    const { client } = fake(() => {
      throw Object.assign(new Error('AccessDenied on arn:aws:ssm:...'), { name: 'AccessDenied' });
    });
    const error = await ssmSecret('/dev/x', client)().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect((error as Error).message).toBe('secret unavailable');
  });
});
