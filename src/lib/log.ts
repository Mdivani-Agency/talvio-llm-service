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
  /** Executor bookkeeping: what a run did, why it skipped, which step, how many items. */
  outcome?: string;
  reason?: string;
  step?: string;
  count?: number;
  failed?: number;
  /** Provider call accounting: content-free ids, token counts and money. */
  requestId?: string;
  promptVersion?: string;
  modelId?: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicroUsd?: number;
};

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/*
 * Metrics (MDI-223, design §13) are written as CloudWatch embedded metric format lines on the
 * same stream, so they need no extra call or permission. Like log fields they are an allow-list:
 * numbers under fixed names, and dimensions whose values must look like an enum member
 * (operation, outcome, quota kind), so no id or text can become a metric dimension.
 */

export const METRIC_NAMESPACE = 'Talvio/LLM';

const METRIC_UNITS = {
  /** A job reached an end state (dimensions: operation, outcome). */
  JobFinished: 'Count',
  /** Admission to end state. */
  JobDurationMs: 'Milliseconds',
  /** Committed spend of a finished job. */
  JobCostMicroUsd: 'None',
  JobRetried: 'Count',
  /** A worker's write lost to a newer lease, a cancellation or a deletion. */
  JobStale: 'Count',
  ModelCalls: 'Count',
  ModelInputTokens: 'Count',
  ModelOutputTokens: 'Count',
  ModelCostMicroUsd: 'None',
  GuardrailBlocked: 'Count',
  /** A published result failed its contract check and was not published. */
  ResultInvalid: 'Count',
  /** Admission refused by a limit (dimension: kind). */
  QuotaRejected: 'Count',
  ReconcileDue: 'Count',
  /** Jobs ended by their deadline: work that got stuck. */
  ReconcileExpired: 'Count',
  /** Jobs sent again after a lost send or a dead worker. */
  ReconcileRequeued: 'Count',
  ReconcileFailed: 'Count',
  DeadLetters: 'Count',
} as const;

export type MetricName = keyof typeof METRIC_UNITS;
export type MetricValues = Partial<Record<MetricName, number>>;
export type MetricDimensions = { operation?: string; outcome?: string; kind?: string };

const DIMENSION_VALUE = /^[a-z0-9_]{1,64}$/;

export type Logger = {
  log(level: LogLevel, fields: LogFields): void;
  /** Records metrics; written whatever the log level. */
  metric(values: MetricValues, dimensions?: MetricDimensions): void;
};

export function createLogger(
  minLevel: LogLevel = 'info',
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  options: { stage?: string } = {},
): Logger {
  const stage = options.stage && DIMENSION_VALUE.test(options.stage) ? options.stage : 'local';
  return {
    log(level, fields) {
      if (ORDER[level] < ORDER[minLevel]) {
        return;
      }
      write(JSON.stringify({ level, time: new Date().toISOString(), ...fields }));
    },
    metric(values, dimensions = {}) {
      const metrics = (Object.keys(values) as MetricName[]).filter(
        (name) => name in METRIC_UNITS && Number.isFinite(values[name]),
      );
      if (metrics.length === 0) return;
      const dims: Record<string, string> = { Stage: stage };
      for (const [key, value] of Object.entries(dimensions)) {
        if (value === undefined) continue;
        const name = `${key[0]!.toUpperCase()}${key.slice(1)}`;
        dims[name] = DIMENSION_VALUE.test(value) ? value : 'other';
      }
      const extra = Object.keys(dims).filter((name) => name !== 'Stage');
      // Totals per stage and per single dimension for alarms; the full breakdown for dashboards.
      const sets = [['Stage'], ...extra.map((name) => ['Stage', name])];
      if (extra.length > 1) sets.push(['Stage', ...extra]);
      write(
        JSON.stringify({
          _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
              {
                Namespace: METRIC_NAMESPACE,
                Dimensions: sets,
                Metrics: metrics.map((name) => ({ Name: name, Unit: METRIC_UNITS[name] })),
              },
            ],
          },
          ...dims,
          ...Object.fromEntries(metrics.map((name) => [name, values[name]])),
        }),
      );
    },
  };
}

/** Short one-way reference to a user id, enough to correlate log lines without the id itself. */
export function userRef(userId: string): string {
  return createHash('sha256').update(`talvio-llm:${userId}`).digest('hex').slice(0, 12);
}
