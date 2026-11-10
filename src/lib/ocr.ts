import { LIMITS } from '@talvio/llm-contracts';
import {
  GetDocumentTextDetectionCommand,
  StartDocumentTextDetectionCommand,
  TextractClient,
} from '@aws-sdk/client-textract';
import { z } from 'zod';

import { RejectedDocumentError } from './extract/errors';

/*
 * Asynchronous text detection (design §8). A worker never waits for Textract: it starts the
 * operation with a stable idempotency token, records the provider job id and returns; Textract
 * publishes completion to SNS and SQS, and `completeOcr` (worker/ocr.ts) paginates the result and
 * finishes the document. The product limit of 3 pages is checked before the first paid call.
 */

export type OcrSource = { bucket: string; key: string; versionId: string | null };

export type OcrPage = { page: number; lines: string[] };

export type OcrResult = {
  status: 'SUCCEEDED' | 'PARTIAL_SUCCESS' | 'FAILED' | 'IN_PROGRESS';
  pages: OcrPage[];
  warnings: string[];
};

export interface OcrClient {
  /** Starts detection. The same `clientToken` returns the same operation, so a retry never pays twice. */
  start(input: {
    source: OcrSource;
    clientToken: string;
    jobTag: string;
    notification: { topicArn: string; roleArn: string };
  }): Promise<{ jobId: string }>;
  /** One page of results. `nextToken` null means the last page. */
  results(
    jobId: string,
    nextToken: string | null,
  ): Promise<{
    status: OcrResult['status'];
    pages: OcrPage[];
    warnings: string[];
    nextToken: string | null;
  }>;
}

/** Product limit, checked before Textract is called. Never confused with AWS's own limits. */
export function planOcr(pagesNeedingOcr: number[]): void {
  if (pagesNeedingOcr.length > LIMITS.ocrPages) {
    throw new RejectedDocumentError('ocr_page_limit');
  }
}

/** Textract's JobTag allows 64 characters; two UUIDs without dashes fit exactly. */
export const jobTag = (ownerId: string, documentId: string) =>
  `${ownerId.replace(/-/g, '')}${documentId.replace(/-/g, '')}`;

const dashed = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

export function parseJobTag(tag: string): { ownerId: string; documentId: string } | null {
  if (!/^[0-9a-f]{64}$/.test(tag)) return null;
  return { ownerId: dashed(tag.slice(0, 32)), documentId: dashed(tag.slice(32)) };
}

/** What Textract publishes on completion (after unwrapping the SNS envelope). */
const notificationSchema = z.object({
  JobId: z.string().min(1).max(256),
  Status: z.enum(['SUCCEEDED', 'FAILED', 'ERROR']),
  JobTag: z.string().max(64).optional(),
});

export type OcrNotification = { jobId: string; status: 'SUCCEEDED' | 'FAILED'; tag: string | null };

/** The notification in an SQS record body (an SNS envelope), or null when it is not one. */
export function parseOcrNotification(body: string): OcrNotification | null {
  try {
    const outer = JSON.parse(body) as { Message?: unknown };
    const inner =
      typeof outer.Message === 'string' ? (JSON.parse(outer.Message) as unknown) : outer;
    const parsed = notificationSchema.safeParse(inner);
    if (!parsed.success) return null;
    return {
      jobId: parsed.data.JobId,
      status: parsed.data.Status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
      tag: parsed.data.JobTag ?? null,
    };
  } catch {
    return null;
  }
}

/** Upper bound on result pages read for one operation: 3 pages of lines fit far inside it. */
const MAX_RESULT_PAGES = 50;

/**
 * Reads every result page and merges lines by page number, in page order. Textract returns each
 * block once, so lines are appended as received and identical text on one page (a repeated job
 * title, say) is kept. Pages Textract did not return are reported as warnings, never filled in or guessed.
 */
export async function collectOcr(
  client: OcrClient,
  jobId: string,
  expectedPages: number,
): Promise<OcrResult & { missingPages: number[] }> {
  const byPage = new Map<number, string[]>();
  const warnings = new Set<string>();
  let status: OcrResult['status'] = 'SUCCEEDED';
  let token: string | null = null;
  for (let i = 0; i < MAX_RESULT_PAGES; i += 1) {
    const page = await client.results(jobId, token);
    status = page.status;
    if (page.status === 'IN_PROGRESS' || page.status === 'FAILED') {
      return { status: page.status, pages: [], warnings: [], missingPages: [] };
    }
    for (const w of page.warnings) warnings.add(w);
    for (const part of page.pages) {
      byPage.set(part.page, [...(byPage.get(part.page) ?? []), ...part.lines]);
    }
    token = page.nextToken;
    if (!token) {
      const pages = [...byPage.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([number, lines]) => ({ page: number, lines }));
      const missingPages = Array.from({ length: expectedPages }, (_, n) => n + 1).filter(
        (n) => !byPage.has(n),
      );
      return { status, pages, warnings: [...warnings], missingPages };
    }
  }
  // Never silently truncate: an unbounded result is a failure the caller must report.
  throw new Error('ocr result exceeded the page bound');
}

export function createTextractClient(client = new TextractClient({ maxAttempts: 3 })): OcrClient {
  return {
    async start({ source, clientToken, jobTag: tag, notification }) {
      const out = await client.send(
        new StartDocumentTextDetectionCommand({
          DocumentLocation: {
            S3Object: {
              Bucket: source.bucket,
              Name: source.key,
              ...(source.versionId ? { Version: source.versionId } : {}),
            },
          },
          ClientRequestToken: clientToken,
          JobTag: tag,
          NotificationChannel: {
            SNSTopicArn: notification.topicArn,
            RoleArn: notification.roleArn,
          },
        }),
      );
      if (!out.JobId) throw new Error('textract returned no job id');
      return { jobId: out.JobId };
    },
    async results(jobId, nextToken) {
      const out = await client.send(
        new GetDocumentTextDetectionCommand({
          JobId: jobId,
          MaxResults: 1000,
          ...(nextToken ? { NextToken: nextToken } : {}),
        }),
      );
      const pages = new Map<number, string[]>();
      for (const block of out.Blocks ?? []) {
        if (block.BlockType !== 'LINE' || !block.Text) continue;
        const number = block.Page ?? 1;
        pages.set(number, [...(pages.get(number) ?? []), block.Text]);
      }
      const status =
        out.JobStatus === 'SUCCEEDED'
          ? 'SUCCEEDED'
          : out.JobStatus === 'PARTIAL_SUCCESS'
            ? 'PARTIAL_SUCCESS'
            : out.JobStatus === 'FAILED'
              ? 'FAILED'
              : 'IN_PROGRESS';
      return {
        status,
        pages: [...pages.entries()].map(([page, lines]) => ({ page, lines })),
        warnings: (out.Warnings ?? []).map((w) => w.ErrorCode ?? 'warning'),
        nextToken: out.NextToken ?? null,
      };
    },
  };
}

/** A scriptable client for tests. */
export function createMemoryOcr(): OcrClient & {
  started: { jobId: string; clientToken: string; jobTag: string; source: OcrSource }[];
  /** Result pages per job, as Textract would page them; the last has no token. */
  scripts: Map<string, ReturnType<OcrClient['results']> extends Promise<infer R> ? R[] : never>;
} {
  const started: { jobId: string; clientToken: string; jobTag: string; source: OcrSource }[] = [];
  const scripts = new Map<string, Awaited<ReturnType<OcrClient['results']>>[]>();
  return {
    started,
    scripts,
    async start({ source, clientToken, jobTag: tag }) {
      // The same token is the same operation: a retry does not start (or pay for) a second one.
      const existing = started.find((s) => s.clientToken === clientToken);
      if (existing) return { jobId: existing.jobId };
      const jobId = `job-${started.length + 1}`;
      started.push({ jobId, clientToken, jobTag: tag, source });
      return { jobId };
    },
    async results(jobId, nextToken) {
      const pages = scripts.get(jobId) ?? [];
      const index = nextToken ? Number(nextToken) : 0;
      const page = pages[index];
      if (!page) return { status: 'IN_PROGRESS', pages: [], warnings: [], nextToken: null };
      return { ...page, nextToken: index + 1 < pages.length ? String(index + 1) : null };
    },
  };
}
