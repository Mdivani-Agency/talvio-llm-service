import { METRIC_NAMESPACE, createLogger } from './log';

describe('logger', () => {
  it('writes lines at or above its level', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', (line) => lines.push(line));
    logger.log('info', { event: 'quiet' });
    logger.log('error', { event: 'loud', jobId: 'job-1' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'error', event: 'loud', jobId: 'job-1' });
  });

  describe('metrics', () => {
    it('writes embedded metric format with totals per stage and per dimension, and the breakdown', () => {
      const lines: string[] = [];
      const logger = createLogger('error', (line) => lines.push(line), { stage: 'dev' });
      logger.metric(
        { JobFinished: 1, JobDurationMs: 1_200, JobCostMicroUsd: 4_000 },
        { operation: 'parse_document', outcome: 'succeeded' },
      );
      expect(lines).toHaveLength(1);
      const line = JSON.parse(lines[0]!);
      expect(line).toMatchObject({
        Stage: 'dev',
        Operation: 'parse_document',
        Outcome: 'succeeded',
        JobFinished: 1,
        JobDurationMs: 1_200,
        JobCostMicroUsd: 4_000,
      });
      expect(line._aws.CloudWatchMetrics).toEqual([
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [
            ['Stage'],
            ['Stage', 'Operation'],
            ['Stage', 'Outcome'],
            ['Stage', 'Operation', 'Outcome'],
          ],
          Metrics: [
            { Name: 'JobFinished', Unit: 'Count' },
            { Name: 'JobDurationMs', Unit: 'Milliseconds' },
            { Name: 'JobCostMicroUsd', Unit: 'None' },
          ],
        },
      ]);
      expect(typeof line._aws.Timestamp).toBe('number');
    });

    it('keeps ids and text out of dimensions, and drops unknown or missing values', () => {
      const lines: string[] = [];
      const logger = createLogger('info', (line) => lines.push(line), { stage: 'Not A Stage' });
      logger.metric({ ModelCalls: 1, ModelInputTokens: undefined, Secret: 5 } as never, {
        kind: 'Jane Doe <jane@example.com>',
        operation: undefined,
      });
      const line = JSON.parse(lines[0]!);
      expect(line).toMatchObject({ Stage: 'local', Kind: 'other', ModelCalls: 1 });
      expect(line).not.toHaveProperty('Secret');
      expect(line).not.toHaveProperty('ModelInputTokens');
      expect(line._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Stage'], ['Stage', 'Kind']]);
      expect(lines[0]).not.toContain('jane');

      logger.metric({ ModelInputTokens: Number.NaN });
      expect(lines).toHaveLength(1);
      logger.metric({ ReconcileDue: 0 });
      expect(JSON.parse(lines[1]!)._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Stage']]);
    });
  });
});
