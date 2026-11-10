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
 * /<stage>/llm/<role>-role-arn. The API role cannot call models; the worker and scheduler roles serve the
 * background functions (MDI-215). Tables, buckets, queues and KMS are Terraform-owned too, so this stack creates no
 * IAM roles or stateful resources. Local runs use no role (serverless-offline ignores it).
 */
/**
 * The stage this run targets, read the way `${opt:stage, "dev"}` does. Serverless resolves every
 * `${ssm:}` reference in the config before a command runs, even in unused `custom` branches, so the
 * role lookups are built only for the selected stage and never for local, test or the other stage.
 */
const selectedStage = (): string => {
  const args = process.argv;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--stage' || arg === '-s') return args[i + 1] ?? 'dev';
    if (arg.startsWith('--stage=')) return arg.slice('--stage='.length);
  }
  return 'dev';
};

/** SSM reference for a Terraform-owned Lambda role; no role (undefined) outside dev and prod. */
const roleArn = (role: 'api' | 'authorizer' | 'worker' | 'scheduler'): string | undefined => {
  const stage = selectedStage();
  return stage === 'dev' || stage === 'prod' ? `\${ssm:/${stage}/llm/${role}-role-arn}` : undefined;
};

/** Pipeline releases this build serves. Each has its own Terraform-owned work queue and DLQ. */
const RELEASES = ['v1'] as const;
/** Release new jobs are pinned to (config PIPELINE_RELEASE). */
const CURRENT_RELEASE = 'v1';

/** SSM value under /<stage>/llm/<name>; undefined outside dev and prod (see selectedStage). */
const llmSsm = (name: string): string | undefined => {
  const stage = selectedStage();
  return stage === 'dev' || stage === 'prod' ? `\${ssm:/${stage}/llm/${name}}` : undefined;
};

/** Work queue URLs by release as the JSON map the config expects; none for local runs. */
const bucketEnv = (): Record<string, string> => {
  const stage = selectedStage();
  if (stage !== 'dev' && stage !== 'prod') return {};
  return {
    LLM_QUARANTINE_BUCKET: `\${ssm:/${stage}/s3/llm-quarantine}`,
    LLM_ARTIFACTS_BUCKET: `\${ssm:/${stage}/s3/llm-artifacts}`,
    OCR_TOPIC_ARN: `\${ssm:/${stage}/llm/ocr-topic-arn}`,
    OCR_ROLE_ARN: `\${ssm:/${stage}/llm/textract-role-arn}`,
  };
};

const queueEnv = (): Record<string, string> => {
  const stage = selectedStage();
  if (stage !== 'dev' && stage !== 'prod') return {};
  const urls = Object.fromEntries(RELEASES.map((r) => [r, llmSsm(`work-queue-url-${r}`)]));
  return { WORK_QUEUE_URLS: JSON.stringify(urls) };
};

/**
 * Events for the background functions. SQS ARNs and schedules come from SSM, so local runs
 * (which have no SSM) deploy the functions without triggers.
 */
const sqsEvent = (arnName: string, extra: { maximumConcurrency?: number }) => {
  const arn = llmSsm(arnName);
  return arn === undefined
    ? []
    : [
        {
          sqs: {
            arn,
            batchSize: 1,
            functionResponseType: 'ReportBatchItemFailures' as const,
            ...extra,
          },
        },
      ];
};
const scheduleEvent = (name: string) => {
  const rate = llmSsm(name);
  return rate === undefined ? [] : [{ schedule: rate }];
};

/**
 * Terraform-owned DynamoDB table names, read from SSM /<stage>/dynamodb/llm-<table> on dev and
 * prod only (see selectedStage). Local runs use the memory store, or DynamoDB Local through the
 * shell's LLM_*_TABLE and DYNAMODB_ENDPOINT variables.
 */
const tableEnv = (): Record<string, string> => {
  const stage = selectedStage();
  if (stage !== 'dev' && stage !== 'prod') return {};
  const table = (name: string) => `\${ssm:/${stage}/dynamodb/llm-${name}}`;
  return {
    LLM_JOBS_TABLE: table('jobs'),
    LLM_SESSIONS_TABLE: table('sessions'),
    LLM_QUOTAS_TABLE: table('quotas'),
    LLM_OUTBOX_TABLE: table('outbox'),
  };
};

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
      PIPELINE_RELEASE: CURRENT_RELEASE,
      ...queueEnv(),
      ...bucketEnv(),
      ...tableEnv(),
      NODE_OPTIONS: '--enable-source-maps',
    },
    apiGateway: {
      minimumCompressionSize: 1024,
    },
  },

  functions: {
    api: {
      handler: 'src/handler.main',
      role: roleArn('api'),
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
      role: roleArn('authorizer'),
      memorySize: 256,
      timeout: 5,
    },
    // Background execution (MDI-215). One job per invocation (batch size 1); a failed message
    // goes back to the queue after the visibility timeout and to the DLQ after the receive limit.
    worker: {
      handler: 'src/worker.main',
      role: roleArn('worker'),
      memorySize: 1024,
      timeout: 300,
      events: sqsEvent(`work-queue-arn-${CURRENT_RELEASE}`, { maximumConcurrency: 5 }),
    },
    dlq: {
      handler: 'src/dlq.main',
      role: roleArn('worker'),
      memorySize: 256,
      timeout: 30,
      events: sqsEvent(`work-dlq-arn-${CURRENT_RELEASE}`, {}),
    },
    // Textract completion: finishes documents waiting on asynchronous OCR. One notification per
    // invocation; a notification that beats our own bookkeeping goes back to the queue.
    ocr: {
      handler: 'src/ocr.main',
      role: roleArn('worker'),
      memorySize: 512,
      timeout: 120,
      events: sqsEvent('ocr-queue-arn', { maximumConcurrency: 2 }),
    },
    dispatcher: {
      handler: 'src/dispatcher.main',
      role: roleArn('scheduler'),
      memorySize: 256,
      timeout: 60,
      events: scheduleEvent('dispatcher-schedule'),
    },
    reconciler: {
      handler: 'src/reconciler.main',
      role: roleArn('scheduler'),
      memorySize: 256,
      timeout: 120,
      events: scheduleEvent('reconciler-schedule'),
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
      storeDriver: 'dynamodb',
    },
    prod: {
      domainName: 'talvio.co',
      storeDriver: 'dynamodb',
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
