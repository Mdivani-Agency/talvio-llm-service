import type { APIGatewayAuthorizerResult, APIGatewayTokenAuthorizerEvent } from 'aws-lambda';

import { createAuthorizer } from './api/authorizer';
import { createTokenVerifier } from './lib/auth';
import { ConfigError, loadConfig } from './lib/config';
import { createLogger } from './lib/log';

/*
 * Lambda entry for the API Gateway authorizer. Configuration is validated once per container;
 * with an invalid configuration every request fails, which API Gateway answers with 503
 * (AUTHORIZER_FAILURE), and only the names of the bad variables are logged.
 */

type Authorizer = (event: APIGatewayTokenAuthorizerEvent) => Promise<APIGatewayAuthorizerResult>;

function unavailable(variables: string[]): Authorizer {
  createLogger('error').log('error', { event: 'config_invalid', variables });
  return async () => {
    throw new Error('Authorizer unavailable');
  };
}

function build(): Authorizer {
  try {
    const config = loadConfig();
    return createAuthorizer({
      verifyToken: createTokenVerifier(config),
      logger: createLogger(config.LOG_LEVEL),
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      return unavailable(error.variables);
    }
    throw error;
  }
}

let authorizer: Authorizer | undefined;

export const main: Authorizer = (event) => {
  authorizer ??= build();
  return authorizer(event);
};
