import type { AWS } from '@serverless/typescript';

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
 * Authentication runs inside the function (Supabase JWT + active-account check), not in a
 * cached API Gateway authorizer, so a revoked account is refused immediately.
 * The function has no AWS permissions yet: it cannot call Bedrock, read artifacts or reach
 * queues. MDI-213 adds the scoped worker and storage roles.
 */
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
    iam: {
      role: {
        statements: [],
      },
    },
  },

  functions: {
    api: {
      handler: 'src/handler.main',
      events: ROUTE_TABLE.map((route) => ({
        http: { method: route.method.toLowerCase(), path: route.path.slice(1) },
      })),
    },
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
    dev: { domainName: 'dev.talvio.co', storeDriver: 'unconfigured' },
    prod: { domainName: 'talvio.co', storeDriver: 'unconfigured' },
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
