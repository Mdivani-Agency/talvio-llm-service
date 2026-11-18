import { S3Client } from '@aws-sdk/client-s3';

import { createS3Blobs, hexToBase64, ObjectTooLargeError } from './blob';

type Sent = { name: string; input: Record<string, unknown> };

function fakeClient(respond: (sent: Sent) => unknown) {
  const sent: Sent[] = [];
  const client = {
    config: {
      region: async () => 'us-west-1',
      credentials: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }),
    },
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const entry = { name: command.constructor.name, input: command.input };
      sent.push(entry);
      return respond(entry);
    },
  } as unknown as S3Client;
  return { client, sent };
}

const buckets = { quarantine: 'q-bucket', artifacts: 'a-bucket' };
const sha = 'ab'.repeat(32);

describe('createS3Blobs', () => {
  it('signs content type, length and checksum into the upload URL', async () => {
    // Signing is local, so a real client with static credentials is used.
    const client = new S3Client({
      region: 'us-west-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    });
    const blobs = createS3Blobs(buckets, { client });
    const now = new Date('2026-11-10T12:00:00Z');
    const grant = await blobs.grantUpload(
      {
        key: 'pending/o/1',
        contentType: 'text/plain',
        sizeBytes: 12,
        sha256: sha,
        expiresInSeconds: 300,
      },
      now,
    );
    const url = new URL(grant.url);
    expect(url.hostname).toContain('q-bucket');
    expect(url.pathname).toBe('/pending/o/1');
    const signed = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
    expect(signed).toEqual(expect.arrayContaining(['content-type', 'content-length']));
    expect(grant.headers['x-amz-checksum-sha256']).toBe(hexToBase64(sha));
    expect(grant.expiresAt.toISOString()).toBe('2026-11-10T12:05:00.000Z');
  });

  it('reads an exact version and enforces the size limit', async () => {
    const { client, sent } = fakeClient(() => ({
      ContentLength: 3,
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    }));
    const blobs = createS3Blobs(buckets, { client });
    expect(await blobs.read('quarantine', 'k', 'v7', 10)).toEqual(new Uint8Array([1, 2, 3]));
    expect(sent[0]?.input).toMatchObject({ Bucket: 'q-bucket', Key: 'k', VersionId: 'v7' });
    await expect(blobs.read('quarantine', 'k', 'v7', 2)).rejects.toBeInstanceOf(
      ObjectTooLargeError,
    );
  });

  it('returns null for a missing key or version, and rethrows other errors', async () => {
    const missing = createS3Blobs(buckets, {
      client: fakeClient(() =>
        Promise.reject(Object.assign(new Error('x'), { name: 'NoSuchVersion' })),
      ).client,
    });
    expect(await missing.read('artifacts', 'k', 'v1', 10)).toBeNull();
    const broken = createS3Blobs(buckets, {
      client: fakeClient(() =>
        Promise.reject(Object.assign(new Error('x'), { name: 'AccessDenied' })),
      ).client,
    });
    await expect(broken.read('artifacts', 'k', null, 10)).rejects.toThrow();
  });

  it('heads with checksum mode, maps NotFound to null, writes and removes in the right bucket', async () => {
    const { client, sent } = fakeClient(({ name }) =>
      name === 'HeadObjectCommand'
        ? { ContentLength: 5, VersionId: 'v2', ContentType: 'text/plain', ChecksumSHA256: 'abc=' }
        : { VersionId: 'v9' },
    );
    const blobs = createS3Blobs(buckets, { client });
    expect(await blobs.head('quarantine', 'k')).toEqual({
      size: 5,
      versionId: 'v2',
      contentType: 'text/plain',
      checksumSha256: 'abc=',
    });
    expect(sent[0]?.input).toMatchObject({ ChecksumMode: 'ENABLED' });
    expect(await blobs.write('artifacts', 'r/k', new Uint8Array([1]), 'application/json')).toBe(
      'v9',
    );
    await blobs.remove('quarantine', 'k');
    expect(sent[1]?.input).toMatchObject({ Bucket: 'a-bucket', Key: 'r/k' });
    expect(sent[2]).toMatchObject({
      name: 'DeleteObjectCommand',
      input: { Bucket: 'q-bucket', Key: 'k' },
    });

    const gone = createS3Blobs(buckets, {
      client: fakeClient(() => Promise.reject(Object.assign(new Error('x'), { name: 'NotFound' })))
        .client,
    });
    expect(await gone.head('quarantine', 'k')).toBeNull();
  });
});
