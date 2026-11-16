import { createHash, randomUUID } from 'crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { Config } from './config';
import type { UploadGrant } from './store';

/*
 * Private object storage: the quarantine bucket (uploads, derivatives) and the artifacts bucket
 * (extracted text). Both are Terraform-owned, versioned and never public; the key layout is fixed by
 * modules/llm/storage.tf: quarantine `pending/<owner>/<random>`, `derivatives/...`; artifacts
 * `results/...`. An upload is addressed by key *and* version, so replacing the object after
 * acceptance cannot change what was accepted.
 */

export type BucketKind = 'quarantine' | 'artifacts';

export type ObjectHead = {
  size: number;
  versionId: string | null;
  contentType: string | null;
  /** Base64 SHA-256 the uploader sent with the object, when S3 recorded one. */
  checksumSha256: string | null;
};

export type GrantConstraints = {
  key: string;
  contentType: string;
  sizeBytes: number;
  /** Hex SHA-256 of the file; sent as a signed checksum header so S3 rejects other bytes. */
  sha256: string;
  expiresInSeconds: number;
};

export interface BlobStore {
  /** A short-lived PUT for exactly one object: its type, length and checksum are signed. */
  grantUpload(constraints: GrantConstraints, now: Date): Promise<UploadGrant>;
  /** Null when the object does not exist. */
  head(bucket: BucketKind, key: string): Promise<ObjectHead | null>;
  /** The bytes of one object version, refusing anything larger than `maxBytes`. */
  read(
    bucket: BucketKind,
    key: string,
    versionId: string | null,
    maxBytes: number,
  ): Promise<Uint8Array | null>;
  /** Writes an object and returns its version. */
  write(
    bucket: BucketKind,
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<string | null>;
  /** Removes every version of the key. */
  remove(bucket: BucketKind, key: string): Promise<void>;
}

export const hexToBase64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Random owner-scoped key for a new upload; the extension and name are never part of it. */
export const uploadKey = (ownerId: string) => `pending/${ownerId}/${randomUUID()}`;
export const textArtifactKey = (ownerId: string, documentId: string) =>
  `results/${ownerId}/documents/${documentId}/text.json`;

export class ObjectTooLargeError extends Error {
  constructor() {
    super('object exceeds the size limit');
    this.name = 'ObjectTooLargeError';
  }
}

export function createS3Blobs(
  buckets: Record<BucketKind, string>,
  options: { client?: S3Client; config?: S3ClientConfig } = {},
): BlobStore {
  const client = options.client ?? new S3Client({ maxAttempts: 3, ...options.config });
  return {
    async grantUpload(c, now) {
      const checksum = hexToBase64(c.sha256);
      const command = new PutObjectCommand({
        Bucket: buckets.quarantine,
        Key: c.key,
        ContentType: c.contentType,
        ContentLength: c.sizeBytes,
        ChecksumSHA256: checksum,
        // Uploads are encrypted with the bucket default key; no public ACL is possible.
      });
      const url = await getSignedUrl(client, command, {
        expiresIn: c.expiresInSeconds,
        signableHeaders: new Set(['content-type', 'content-length', 'x-amz-checksum-sha256']),
      });
      return {
        method: 'PUT',
        url,
        headers: {
          'content-type': c.contentType,
          'content-length': String(c.sizeBytes),
          'x-amz-checksum-sha256': checksum,
        },
        expiresAt: new Date(now.getTime() + c.expiresInSeconds * 1000),
      };
    },
    async head(bucket, key) {
      try {
        const out = await client.send(
          new HeadObjectCommand({ Bucket: buckets[bucket], Key: key, ChecksumMode: 'ENABLED' }),
        );
        return {
          size: out.ContentLength ?? 0,
          versionId: out.VersionId ?? null,
          contentType: out.ContentType ?? null,
          checksumSha256: out.ChecksumSHA256 ?? null,
        };
      } catch (error) {
        if ((error as { name?: string }).name === 'NotFound') return null;
        throw error;
      }
    },
    async read(bucket, key, versionId, maxBytes) {
      let out;
      try {
        out = await client.send(
          new GetObjectCommand({
            Bucket: buckets[bucket],
            Key: key,
            ...(versionId ? { VersionId: versionId } : {}),
          }),
        );
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name === 'NoSuchKey' || name === 'NoSuchVersion') return null;
        throw error;
      }
      if ((out.ContentLength ?? 0) > maxBytes || !out.Body) throw new ObjectTooLargeError();
      const bytes = await out.Body.transformToByteArray();
      if (bytes.length > maxBytes) throw new ObjectTooLargeError();
      return bytes;
    },
    async write(bucket, key, body, contentType) {
      const out = await client.send(
        new PutObjectCommand({
          Bucket: buckets[bucket],
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      return out.VersionId ?? null;
    },
    async remove(bucket, key) {
      // Without a VersionId on a versioned bucket this adds a delete marker; the lifecycle rules
      // remove the versions behind it. Version-level cleanup is done by the sweep with listings.
      await client.send(new DeleteObjectCommand({ Bucket: buckets[bucket], Key: key }));
    },
  };
}

type Stored = {
  body: Uint8Array;
  versions: { id: string; body: Uint8Array; contentType: string }[];
};

/** In-process blobs for tests and local runs. Versioned like the real buckets. */
export function createMemoryBlobs(): BlobStore & {
  /** What an uploader would do with a valid grant. */
  upload(key: string, body: Uint8Array, contentType: string): string;
  keys(bucket: BucketKind): string[];
} {
  const objects: Record<BucketKind, Map<string, Stored>> = {
    quarantine: new Map(),
    artifacts: new Map(),
  };
  let counter = 0;
  const put = (bucket: BucketKind, key: string, body: Uint8Array, contentType: string) => {
    counter += 1;
    const id = `v${counter}`;
    const entry = objects[bucket].get(key) ?? { body, versions: [] };
    entry.body = body;
    entry.versions.push({ id, body, contentType });
    objects[bucket].set(key, entry);
    return id;
  };
  return {
    upload: (key, body, contentType) => put('quarantine', key, body, contentType),
    keys: (bucket) => [...objects[bucket].keys()],
    async grantUpload(c, now) {
      return {
        method: 'PUT',
        url: `https://uploads.local.invalid/${c.key}`,
        headers: { 'content-type': c.contentType, 'x-amz-checksum-sha256': hexToBase64(c.sha256) },
        expiresAt: new Date(now.getTime() + c.expiresInSeconds * 1000),
      };
    },
    async head(bucket, key) {
      const entry = objects[bucket].get(key);
      const last = entry?.versions[entry.versions.length - 1];
      if (!entry || !last) return null;
      return {
        size: last.body.length,
        versionId: last.id,
        contentType: last.contentType,
        checksumSha256: hexToBase64(sha256Hex(last.body)),
      };
    },
    async read(bucket, key, versionId, maxBytes) {
      const entry = objects[bucket].get(key);
      const version = versionId
        ? entry?.versions.find((v) => v.id === versionId)
        : entry?.versions[entry.versions.length - 1];
      if (!version) return null;
      if (version.body.length > maxBytes) throw new ObjectTooLargeError();
      return version.body;
    },
    async write(bucket, key, body, contentType) {
      return put(bucket, key, body, contentType);
    },
    async remove(bucket, key) {
      objects[bucket].delete(key);
    },
  };
}

/** S3 when both buckets are configured, otherwise in-process blobs (local runs and tests only; config enforces this). */
export function createBlobs(
  config: Pick<Config, 'LLM_QUARANTINE_BUCKET' | 'LLM_ARTIFACTS_BUCKET'>,
): BlobStore {
  return config.LLM_QUARANTINE_BUCKET && config.LLM_ARTIFACTS_BUCKET
    ? createS3Blobs({
        quarantine: config.LLM_QUARANTINE_BUCKET,
        artifacts: config.LLM_ARTIFACTS_BUCKET,
      })
    : createMemoryBlobs();
}
