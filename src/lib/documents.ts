import type { BlobStore } from './blob';
import type { Logger } from './log';
import type { DocumentRecord } from './store';

/**
 * Removes every object a document owns. Best effort per object: a failure is logged by name only
 * and the lifecycle rules on both buckets remove what a retry misses. The extracted text is
 * removed even when the record was deleted while extraction was still running (the worker checks
 * for the record after writing and calls this too).
 */
export async function removeDocumentObjects(
  deps: { blobs: BlobStore; logger: Logger },
  document: Pick<DocumentRecord, 'objectKey' | 'artifact'>,
): Promise<void> {
  const targets: Parameters<BlobStore['remove']>[] = [['quarantine', document.objectKey]];
  if (document.artifact) targets.push(['artifacts', document.artifact.key]);
  for (const [bucket, key] of targets) {
    try {
      await deps.blobs.remove(bucket, key);
    } catch (error) {
      deps.logger.log('warn', {
        event: 'cleanup_failed',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}
