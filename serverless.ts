import type { AWS } from '@serverless/typescript';

import {
  GATEWAY_ERRORS,
  GATEWAY_HEADERS,
  type GatewayResponseType,
} from './src/api/gateway-responses';
import { ROUTE_TABLE } from './src/api/route-table';

type ServerlessV4 = AWS & {
  build?: {
    esbuild?: {
      bundle?: boolean;
      minify?: boolean;
      sourcemap?: boolean;
      exclude?: string[];
    };
  };
};

/*
 * One Lambda serves every /llm/v1 route; API Gateway exposes only the routes in ROUTE_TABLE.
 * Every route except health goes through the `authorizer` Lambda (src/api/authorizer.ts),
 * which verifies the Supabase access token and its account_status and plan claims. Its
 * results are not cached, and its refusals use the contract's error shape (GATEWAY_ERRORS).
 * Each function runs under a role Terraform owns (talvio-terraform-iac modules/llm), read from SSM
 * /<stage>/llm/<role>-role-arn. The API role cannot call models; the worker role arrives with the worker
 * functions (MDI-215). Tables, buckets, queues and KMS are Terraform-owned too, so this stack creates no
 * IAM roles or stateful resources. Local runs use no role (serverless-offline ignores it).
 */
const AUTHORIZER = {
  name: 'authorizer',
  type: 'token',
  identitySource: 'method.request.header.Authorization',
  resultTtlInSeconds: 0,
};

const quoted = (value: string) => `'${value}'`;
/** ACCESS_DENIED → AccessDenied, for CloudFormation logical ids. */
const pascal = (type: string) =>
  type
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');

const gatewayResponses = Object.fromEntries(
  (Object.keys(GATEWAY_ERRORS) as GatewayResponseType[]).map((type) => {
    const { status, code, message, retryable } = GATEWAY_ERRORS[type];
    const body = JSON.stringify({ error: { code, message, retryable, correlationId: '@ID@' } });
    return [
      `GatewayResponse${pascal(type)}`,
      {
        Type: 'AWS::ApiGateway::GatewayResponse',
        Properties: {
          RestApiId: { Ref: 'ApiGatewayRestApi' },
          ResponseType: type,
          StatusCode: String(status),
          ResponseParameters: Object.fromEntries(
            Object.entries(GATEWAY_HEADERS).map(([name, value]) => [
              `gatewayresponse.header.${name}`,
              quoted(value),
            ]),
          ),
          ResponseTemplates: {
            'application/json': body.replace('"@ID@"', '"$context.requestId"'),
          },
        },
      },
    ];
  }),
);

const serverlessConfiguration: ServerlessV4 = {
  service: 'llm-service',
  frameworkVersion: '4',

  provider: {
    name: 'aws',
    runtime: 'nodejs22.x',
    architecture: 'arm64',
    stage: '${opt:stage, "dev"}',
    region: 'us-west-1',
    memorySize: 512,
    timeout: 10,
    logRetentionInDays: 14,
    environment: {
      STAGE: '${self:provider.stage}',
      // Local runs read SUPABASE_URL from the shell; deployed stages read SSM.
      SUPABASE_URL: '${env:SUPABASE_URL, ssm:/${self:provider.stage}/supabase/url}',
      STORE_DRIVER: '${self:custom.${self:provider.stage}.storeDriver, "unconfigured"}',
      NODE_OPTIONS: '--enable-source-maps',
    },
    apiGateway: {
      minimumCompressionSize: 1024,
    },
  },

  functions: {
    api: {
      handler: 'src/handler.main',
      role: '${self:custom.${self:provider.stage}.roles.api, ""}',
      events: ROUTE_TABLE.map((route) => ({
        http: {
          method: route.method.toLowerCase(),
          path: route.path.slice(1),
          ...('public' in route && route.public ? {} : { authorizer: AUTHORIZER }),
        },
      })),
    },
    authorizer: {
      handler: 'src/authorizer.main',
      role: '${self:custom.${self:provider.stage}.roles.authorizer, ""}',
      memorySize: 256,
      timeout: 5,
    },
  },

  resources: {
    Resources: gatewayResponses,
  },

  plugins: ['serverless-offline', 'serverless-domain-manager'],

  build: {
    esbuild: {
      bundle: true,
      minify: true,
      sourcemap: true,
      // Bundle pinned dependencies instead of relying on the Lambda runtime SDK.
      exclude: ['!@aws-sdk/*'],
    },
  },

  custom: {
    local: { domainName: 'dev.talvio.co', storeDriver: 'memory', customDomainEnabled: false },
    dev: {
      domainName: 'dev.talvio.co',
      storeDriver: 'unconfigured',
      roles: {
        api: '${ssm:/dev/llm/api-role-arn}',
        authorizer: '${ssm:/dev/llm/authorizer-role-arn}',
      },
    },
    prod: {
      domainName: 'talvio.co',
      storeDriver: 'unconfigured',
      roles: {
        api: '${ssm:/prod/llm/api-role-arn}',
        authorizer: '${ssm:/prod/llm/authorizer-role-arn}',
      },
    },
    customDomain: {
      rest: {
        // The shared api.<domain> custom domain and its DNS record belong to the platform
        // stack; this service only adds its own `llm` base path mapping.
        domainName: 'api.${self:custom.${self:provider.stage}.domainName}',
        basePath: 'llm',
        stage: '${self:provider.stage}',
        endpointType: 'edge',
        securityPolicy: 'tls_1_2',
        createRoute53Record: false,
        autoDomain: false,
        enabled: '${self:custom.${self:provider.stage}.customDomainEnabled, true}',
      },
    },
    'serverless-offline': {
      httpPort: 3005,
      noPrependStageInUrl: true,
    },
  },

  package: {
    individually: true,
  },
};

module.exports = serverlessConfiguration;
