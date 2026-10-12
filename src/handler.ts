import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { createApp } from './api/app';
import { createTokenVerifier } from './lib/auth';
import { ConfigError, loadConfig } from './lib/config';
import { createLogger } from './lib/log';
import { createStore } from './lib/store';

/*
 * Lambda entry for every /llm/v1 route. Configuration is validated once per container; an
 * invalid configuration answers 503 on every route (health included) and logs only the names
 * of the bad variables.
 */

type Handler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

function unavailable(variables: string[]): Handler {
  const logger = createLogger('error');
  logger.log('error', { event: 'config_invalid', variables });
  return async () => ({
    statusCode: 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      error: {
        code: 'dependency_unavailable',
        message: 'AI features are temporarily unavailable. Try again later.',
        retryable: true,
        correlationId: 'unavailable',
      },
    }),
  });
}

function build(): Handler {
  try {
    const config = loadConfig();
    return createApp({
      store: createStore(config),
      logger: createLogger(config.LOG_LEVEL),
      verifyToken: createTokenVerifier(config),
      maxBodyBytes: config.MAX_BODY_BYTES,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      return unavailable(error.variables);
    }
    throw error;
  }
}

let app: Handler | undefined;

export const main: Handler = (event) => {
  app ??= build();
  return app(event);
};
