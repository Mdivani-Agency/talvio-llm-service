import { errorBodySchema, HTTP_ERROR_STATUS } from '@talvio/llm-contracts';

import { GATEWAY_ERRORS, gatewayBody, type GatewayResponseType } from './gateway-responses';

describe('gateway responses', () => {
  it.each(Object.keys(GATEWAY_ERRORS) as GatewayResponseType[])(
    '%s is a contract error body with a matching status',
    (type) => {
      const body = errorBodySchema.parse(JSON.parse(gatewayBody(type, 'request-id-1234')));
      expect(body.error.correlationId).toBe('request-id-1234');
      expect(GATEWAY_ERRORS[type].status).toBe(HTTP_ERROR_STATUS[body.error.code]);
    },
  );
});

describe('serverless.ts', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require('../../serverless') as {
    functions: {
      api: { events: { http: { path: string; authorizer?: unknown } }[] };
    };
    resources: { Resources: Record<string, { Properties: { ResponseType: string } }> };
  };

  it('puts the uncached authorizer on every route except health', () => {
    for (const { http } of config.functions.api.events) {
      if (http.path === 'v1/health') {
        expect(http.authorizer).toBeUndefined();
      } else {
        expect(http.authorizer).toEqual(
          expect.objectContaining({ name: 'authorizer', type: 'token', resultTtlInSeconds: 0 }),
        );
      }
    }
  });

  it('deploys a gateway response for every authorizer outcome', () => {
    expect(
      Object.values(config.resources.Resources).map((resource) => resource.Properties.ResponseType),
    ).toEqual(Object.keys(GATEWAY_ERRORS));
  });

  describe('Terraform-owned function roles', () => {
    type Roles = {
      provider: { iam?: unknown };
      functions: { api: { role?: string }; authorizer: { role?: string } };
    };
    type Env = { provider: { environment: Record<string, string> } };
    const originalArgv = process.argv;
    const loadFor = (stageArgs: string[]): Roles => {
      process.argv = [...originalArgv, ...stageArgs];
      let loaded: Roles | undefined;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        loaded = require('../../serverless') as Roles;
      });
      return loaded as Roles;
    };
    afterEach(() => {
      process.argv = originalArgv;
    });

    it.each([
      ['dev', ['--stage', 'dev']],
      ['prod', ['--stage=prod']],
      ['dev', []],
    ])('reads only the %s stage roles from SSM and creates no IAM', (stage, args) => {
      const loaded = loadFor(args);
      expect(loaded.provider.iam).toBeUndefined();
      expect(loaded.functions.api.role).toBe(`\${ssm:/${stage}/llm/api-role-arn}`);
      expect(loaded.functions.authorizer.role).toBe(`\${ssm:/${stage}/llm/authorizer-role-arn}`);
    });

    it('references no SSM role for local runs', () => {
      const loaded = loadFor(['--stage', 'local']);
      expect(loaded.functions.api.role).toBeUndefined();
      expect(loaded.functions.authorizer.role).toBeUndefined();
    });

    it.each(['dev', 'prod'])(
      'reads the %s table names from SSM and uses the DynamoDB store',
      (stage) => {
        const { provider } = loadFor(['--stage', stage]) as unknown as Env;
        expect(provider.environment).toMatchObject({
          LLM_JOBS_TABLE: `\${ssm:/${stage}/dynamodb/llm-jobs}`,
          LLM_SESSIONS_TABLE: `\${ssm:/${stage}/dynamodb/llm-sessions}`,
          LLM_QUOTAS_TABLE: `\${ssm:/${stage}/dynamodb/llm-quotas}`,
          LLM_OUTBOX_TABLE: `\${ssm:/${stage}/dynamodb/llm-outbox}`,
        });
        const custom = (
          loadFor(['--stage', stage]) as unknown as Record<
            string,
            Record<string, Record<string, string>>
          >
        ).custom;
        expect(custom?.[stage]?.storeDriver).toBe('dynamodb');
      },
    );

    type Fn = { role?: string; timeout: number; events: Record<string, unknown>[] };
    type Fns = { functions: Record<'worker' | 'dlq' | 'dispatcher' | 'reconciler', Fn> };

    it.each(['dev', 'prod'])('wires the %s background functions from SSM', (stage) => {
      const { functions } = loadFor(['--stage', stage]) as unknown as Fns;
      const ssm = (name: string) => `\${ssm:/${stage}/llm/${name}}`;
      expect(functions.worker.role).toBe(ssm('worker-role-arn'));
      expect(functions.dlq.role).toBe(ssm('worker-role-arn'));
      expect(functions.dispatcher.role).toBe(ssm('scheduler-role-arn'));
      expect(functions.reconciler.role).toBe(ssm('scheduler-role-arn'));
      expect(functions.worker.events).toEqual([
        {
          sqs: {
            arn: ssm('work-queue-arn-v1'),
            batchSize: 1,
            functionResponseType: 'ReportBatchItemFailures',
            maximumConcurrency: 5,
          },
        },
      ]);
      expect(functions.dlq.events).toEqual([
        expect.objectContaining({ sqs: expect.objectContaining({ arn: ssm('work-dlq-arn-v1') }) }),
      ]);
      expect(functions.dispatcher.events).toEqual([{ schedule: ssm('dispatcher-schedule') }]);
      expect(functions.reconciler.events).toEqual([{ schedule: ssm('reconciler-schedule') }]);
      // The queue visibility timeout (6 x worker timeout) must outlive an invocation.
      expect(functions.worker.timeout).toBe(300);
    });

    it.each(['dev', 'prod'])('passes the %s release and queue URLs to every function', (stage) => {
      const { provider } = loadFor(['--stage', stage]) as unknown as Env;
      expect(provider.environment.PIPELINE_RELEASE).toBe('v1');
      expect(JSON.parse(provider.environment.WORK_QUEUE_URLS ?? '')).toEqual({
        v1: `\${ssm:/${stage}/llm/work-queue-url-v1}`,
      });
    });

    it('has no triggers, roles or queue URLs for local runs', () => {
      const loaded = loadFor(['--stage', 'local']) as unknown as Fns & Env;
      const { worker, dlq, dispatcher, reconciler } = loaded.functions;
      for (const fn of [worker, dlq, dispatcher, reconciler]) {
        expect(fn.role).toBeUndefined();
        expect(fn.events).toEqual([]);
      }
      expect(loaded.provider.environment.WORK_QUEUE_URLS).toBeUndefined();
    });

    it('references no table in SSM for local runs', () => {
      const { provider } = loadFor(['--stage', 'local']) as unknown as Env;
      expect(Object.keys(provider.environment).filter((name) => name.endsWith('_TABLE'))).toEqual(
        [],
      );
    });
  });
});
