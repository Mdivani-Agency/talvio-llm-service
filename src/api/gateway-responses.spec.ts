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
  });
});
