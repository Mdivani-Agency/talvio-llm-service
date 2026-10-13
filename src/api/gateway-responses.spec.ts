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
    functions: { api: { events: { http: { path: string; authorizer?: unknown } }[] } };
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
});
