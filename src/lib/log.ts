import { createHash } from 'crypto';

/*
 * Content-free structured logging. Only the fields below can be logged, so request bodies,
 * tokens, document text and provider payloads cannot reach the logs by accident. Errors are
 * logged by name and code only: messages of unknown errors can quote input (JSON.parse does).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = {
  event: string;
  correlationId?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  /** Pseudonymous user reference; see userRef(). */
  user?: string;
  code?: string;
  errorName?: string;
  jobId?: string;
  operation?: string;
  replayed?: boolean;
  variables?: string[];
};

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Logger = {
  log(level: LogLevel, fields: LogFields): void;
};

export function createLogger(
  minLevel: LogLevel = 'info',
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  return {
    log(level, fields) {
      if (ORDER[level] < ORDER[minLevel]) {
        return;
      }
      write(JSON.stringify({ level, time: new Date().toISOString(), ...fields }));
    },
  };
}

/** Short one-way reference to a user id, enough to correlate log lines without the id itself. */
export function userRef(userId: string): string {
  return createHash('sha256').update(`talvio-llm:${userId}`).digest('hex').slice(0, 12);
}
