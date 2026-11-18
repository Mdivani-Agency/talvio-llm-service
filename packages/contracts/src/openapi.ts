import { z } from 'zod';

import { applyReceiptSchema, applyRequestSchema } from './apply';
import { careerDocumentSchema } from './career';
import { contentDocSchema } from './content';
import {
  createDocumentRequestSchema,
  createDocumentResponseSchema,
  documentSchema,
} from './documents';
import { errorBodySchema, HTTP_ERROR_STATUS, jobErrorSchema } from './errors';
import { evidenceRefSchema, factSchema, warningSchema } from './evidence';
import {
  jobDescriptionSchema,
  requirementCoverageSchema,
  requirementSchema,
} from './job-description';
import {
  createJobRequestSchema,
  jobAcceptedSchema,
  jobListSchema,
  jobSchema,
  resultEnvelopeSchemas,
} from './jobs';
import {
  applyTargetSchema,
  omissionSchema,
  proposalSchema,
  proposedChangeSchema,
} from './proposals';
import { questionSchema } from './questions';
import { sourceRefSchema, sourceSnapshotSchema } from './source';
import {
  contextRevisionSchema,
  createContextRequestSchema,
  createSessionRequestSchema,
  sessionSchema,
  submitAnswersRequestSchema,
} from './sessions';
import { API_BASE_PATH, SCHEMA_VERSION } from './version';

/** Named schemas published under components.schemas and as generated/schemas/<Name>.json. */
export const NAMED_SCHEMAS = {
  CareerDocument: careerDocumentSchema,
  Proposal: proposalSchema,
  CreateDocumentRequest: createDocumentRequestSchema,
  CreateDocumentResponse: createDocumentResponseSchema,
  Document: documentSchema,
  CreateSessionRequest: createSessionRequestSchema,
  CreateContextRequest: createContextRequestSchema,
  SubmitAnswersRequest: submitAnswersRequestSchema,
  ContextRevision: contextRevisionSchema,
  Session: sessionSchema,
  CreateJobRequest: createJobRequestSchema,
  JobAccepted: jobAcceptedSchema,
  Job: jobSchema,
  JobList: jobListSchema,
  JobError: jobErrorSchema,
  ErrorBody: errorBodySchema,
  ApplyRequest: applyRequestSchema,
  ApplyReceipt: applyReceiptSchema,
} as const;

export type SchemaName = keyof typeof NAMED_SCHEMAS;

/** Building blocks that appear in several named schemas; OpenAPI references them by name. */
const SHARED_SCHEMAS = {
  ContentDoc: contentDocSchema,
  EvidenceRef: evidenceRefSchema,
  Fact: factSchema,
  Warning: warningSchema,
  JobDescription: jobDescriptionSchema,
  Requirement: requirementSchema,
  RequirementCoverage: requirementCoverageSchema,
  Question: questionSchema,
  SourceRef: sourceRefSchema,
  SourceSnapshot: sourceSnapshotSchema,
  ApplyTarget: applyTargetSchema,
  ProposedChange: proposedChangeSchema,
  Omission: omissionSchema,
  ParseDocumentResult: resultEnvelopeSchemas.parse_document,
  AnalyzeResumeResult: resultEnvelopeSchemas.analyze_resume,
  GenerateQuestionsResult: resultEnvelopeSchemas.generate_questions,
  ImproveProfileResult: resultEnvelopeSchemas.improve_profile,
  ImproveResumeResult: resultEnvelopeSchemas.improve_resume,
  TailorResumeResult: resultEnvelopeSchemas.tailor_resume,
} as const;

const JSON_SCHEMA_OPTIONS = {
  target: 'draft-2020-12',
  io: 'input',
  unrepresentable: 'throw',
} as const;

/**
 * Standalone JSON Schema (draft 2020-12) for every named schema; repeated parts go to `$defs`.
 * Runtime refinements (cross-field rules) are not expressible in JSON Schema and only run in the
 * Zod validators; JSON Schema consumers get a superset of what the service accepts.
 */
export function buildJsonSchemas(): Record<SchemaName, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(NAMED_SCHEMAS).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, { ...JSON_SCHEMA_OPTIONS, reused: 'ref' }),
    ]),
  ) as unknown as Record<SchemaName, Record<string, unknown>>;
}

/** Named and shared schemas as OpenAPI components, cross-referenced by name. */
function buildComponentSchemas(): Record<string, Record<string, unknown>> {
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of Object.entries({ ...NAMED_SCHEMAS, ...SHARED_SCHEMAS })) {
    registry.add(schema, { id: name });
  }
  const output = z.toJSONSchema(registry, {
    ...JSON_SCHEMA_OPTIONS,
    uri: (id) => `#/components/schemas/${id}`,
  });
  const schemas = output.schemas as Record<string, Record<string, unknown>>;
  // Component schemas must not carry $schema/$id of their own.
  for (const schema of Object.values(schemas)) {
    delete schema.$schema;
    delete schema.$id;
  }
  return schemas;
}

const ref = (name: SchemaName) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: SchemaName) => ({ 'application/json': { schema: ref(name) } });
const uuidParam = (name: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});

const errorResponses = (...codes: (keyof typeof HTTP_ERROR_STATUS)[]) =>
  Object.fromEntries(
    [...new Set(codes.map((code) => HTTP_ERROR_STATUS[code]))].map((status) => [
      String(status),
      {
        description: codes.filter((code) => HTTP_ERROR_STATUS[code] === status).join(', '),
        content: json('ErrorBody'),
      },
    ]),
  );

const common = ['invalid_request', 'unauthorized', 'not_found', 'internal_error'] as const;

export function buildOpenApiDocument() {
  const schemas = buildComponentSchemas();

  return {
    openapi: '3.1.0',
    info: {
      title: 'Talvio LLM service',
      version: SCHEMA_VERSION,
      description:
        'Async AI operations for Talvio. Generated from @talvio/llm-contracts; do not edit by hand. Browsers call the same-origin /api/llm adapter, which forwards the Supabase access token.',
    },
    servers: [
      { url: `https://api.dev.talvio.co${API_BASE_PATH}`, description: 'dev' },
      { url: `https://api.talvio.co${API_BASE_PATH}`, description: 'prod' },
    ],
    security: [{ supabaseJwt: [] }],
    paths: {
      '/health': {
        get: {
          operationId: 'getHealth',
          security: [],
          summary: 'Liveness only; reveals no configuration.',
          responses: {
            '200': {
              description: 'Alive',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { const: 'ok' } },
                    required: ['status'],
                    additionalProperties: false,
                  },
                },
              },
            },
          },
        },
      },
      '/documents': {
        post: {
          operationId: 'createDocument',
          summary: 'Register an upload and get a short-lived private upload grant.',
          requestBody: { required: true, content: json('CreateDocumentRequest') },
          responses: {
            '201': { description: 'Created', content: json('CreateDocumentResponse') },
            ...errorResponses(
              ...common,
              'payload_too_large',
              'unsupported_media_type',
              'quota_exceeded',
            ),
          },
        },
      },
      '/documents/{documentId}': {
        parameters: [uuidParam('documentId')],
        get: {
          operationId: 'getDocument',
          responses: {
            '200': { description: 'Document', content: json('Document') },
            ...errorResponses(...common),
          },
        },
        delete: {
          operationId: 'deleteDocument',
          summary: 'Revoke access, cancel dependent work and schedule cleanup.',
          responses: { '204': { description: 'Deleted' }, ...errorResponses(...common) },
        },
      },
      '/documents/{documentId}/complete': {
        parameters: [uuidParam('documentId')],
        post: {
          operationId: 'completeDocument',
          summary: 'Pin the uploaded object and start validation. Runs no OCR or model.',
          responses: {
            '202': { description: 'Validation queued', content: json('Document') },
            ...errorResponses(...common, 'unusable_document', 'unsupported_media_type'),
          },
        },
      },
      '/sessions': {
        post: {
          operationId: 'createSession',
          requestBody: { required: true, content: json('CreateSessionRequest') },
          responses: {
            '201': { description: 'Created (or replayed)', content: json('Session') },
            ...errorResponses(...common, 'payload_too_large', 'quota_exceeded'),
          },
        },
      },
      '/sessions/{sessionId}': {
        parameters: [uuidParam('sessionId')],
        get: {
          operationId: 'getSession',
          responses: {
            '200': { description: 'Session', content: json('Session') },
            ...errorResponses(...common),
          },
        },
        delete: {
          operationId: 'deleteSession',
          responses: { '204': { description: 'Deleted' }, ...errorResponses(...common) },
        },
      },
      '/sessions/{sessionId}/contexts': {
        parameters: [uuidParam('sessionId')],
        post: {
          operationId: 'createContextRevision',
          requestBody: { required: true, content: json('CreateContextRequest') },
          responses: {
            '201': { description: 'New context revision', content: json('ContextRevision') },
            ...errorResponses(...common, 'stale_context', 'payload_too_large'),
          },
        },
      },
      '/sessions/{sessionId}/answers': {
        parameters: [uuidParam('sessionId')],
        post: {
          operationId: 'submitAnswers',
          requestBody: { required: true, content: json('SubmitAnswersRequest') },
          responses: {
            '201': { description: 'New context revision', content: json('ContextRevision') },
            ...errorResponses(...common, 'stale_context'),
          },
        },
      },
      '/jobs': {
        post: {
          operationId: 'createJob',
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              description: 'Must equal clientRequestId.',
              schema: { type: 'string', minLength: 8, maxLength: 128 },
            },
          ],
          requestBody: { required: true, content: json('CreateJobRequest') },
          responses: {
            '202': { description: 'Accepted (or replayed)', content: json('JobAccepted') },
            ...errorResponses(
              ...common,
              'idempotency_key_required',
              'idempotency_conflict',
              'stale_context',
              'payload_too_large',
              'unusable_document',
              'ocr_page_limit',
              'budget_exceeded_preflight',
              'unsupported_language',
              'quota_exceeded',
              'dependency_unavailable',
            ),
          },
        },
        get: {
          operationId: 'listJobs',
          parameters: [
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Jobs', content: json('JobList') },
            ...errorResponses(...common),
          },
        },
      },
      '/jobs/{jobId}': {
        parameters: [uuidParam('jobId')],
        get: {
          operationId: 'getJob',
          responses: {
            '200': { description: 'Job', content: json('Job') },
            ...errorResponses(...common),
          },
        },
        delete: {
          operationId: 'deleteJob',
          responses: { '204': { description: 'Deleted' }, ...errorResponses(...common) },
        },
      },
      '/jobs/{jobId}/cancel': {
        parameters: [uuidParam('jobId')],
        post: {
          operationId: 'cancelJob',
          summary: 'Idempotent; a terminal job is returned unchanged.',
          responses: {
            '200': { description: 'Job', content: json('Job') },
            ...errorResponses(...common),
          },
        },
      },
      '/jobs/{jobId}/retry': {
        parameters: [uuidParam('jobId')],
        post: {
          operationId: 'retryJob',
          summary: 'Retry a retryable failure within the original deadline and budget.',
          responses: {
            '202': { description: 'Requeued', content: json('JobAccepted') },
            ...errorResponses(...common, 'invalid_retry'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        supabaseJwt: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Supabase access token of a signed-in, non-anonymous user.',
        },
      },
      schemas,
    },
  };
}
