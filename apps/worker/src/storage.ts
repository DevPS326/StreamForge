import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { createReadStream, createWriteStream } from "node:fs";
import { opendir, rm, stat, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Artifact, MediaError } from "./media.js";

const scratchReserve = 128 * 1024 ** 2;
export const scratchPrefix = "streamforge-worker-";

export async function removeAbandonedScratch(path: string): Promise<void> {
  const root = resolve(path);
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  const directory = await opendir(root);
  for await (const entry of directory) {
    if (!entry.isDirectory() || !entry.name.startsWith(scratchPrefix)) continue;
    const target = resolve(root, entry.name);
    if (dirname(target) !== root) continue;
    try {
      if ((await stat(target)).mtimeMs < cutoff)
        await rm(target, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class ScratchBudget {
  private reserved = 0;
  constructor(readonly capacity: number) {}

  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.capacity) {
      throw new MediaError(
        "MEDIA_LIMIT_EXCEEDED",
        "The video exceeds the worker temporary storage limit",
      );
    }
    if (this.reserved + bytes > this.capacity) {
      throw new Error("Worker temporary storage is reserved by another job");
    }
    this.reserved += bytes;
    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.reserved -= bytes;
    };
  }
}

export async function requireDiskSpace(path: string, bytes: number) {
  const stats = await statfs(path);
  if (stats.bavail * stats.bsize < bytes + scratchReserve) {
    throw new Error("Insufficient free space for this video");
  }
}

export class MediaStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async download(
    key: string,
    expectedBytes: number,
    destination: string,
    signal: AbortSignal,
  ) {
    const object = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
      { abortSignal: signal },
    );

    if (!(object.Body instanceof Readable))
      throw new Error("Storage returned no readable original");
    if (
      object.ContentLength !== undefined &&
      object.ContentLength !== expectedBytes
    ) {
      object.Body.destroy();
      throw new MediaError(
        "INVALID_MEDIA",
        "The original object size differs from its verified upload",
      );
    }
    let received = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > expectedBytes) {
          return callback(
            new MediaError(
              "INVALID_MEDIA",
              "The original exceeds its verified upload size",
            ),
          );
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      object.Body,
      limit,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    if (received !== expectedBytes)
      throw new Error("Storage returned an incomplete original");
  }

  async uploadVerified(
    prefix: string,
    directory: string,
    artifacts: Artifact[],
    signal: AbortSignal,
  ) {
    for (const artifact of artifacts) {
      signal.throwIfAborted();
      const key = prefix + artifact.relativePath;
      const stream = createReadStream(join(directory, artifact.relativePath), {
        signal,
      });
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: stream,
            ContentType: artifact.contentType,
            ContentLength: artifact.length,
            CacheControl: "private, max-age=300",
          }),
          { abortSignal: signal },
        );
      } finally {
        stream.destroy();
      }
      const stored = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
        { abortSignal: signal },
      );
      if (
        stored.ContentLength !== artifact.length ||
        stored.ContentType !== artifact.contentType ||
        !stored.ETag
      ) {
        throw new Error(`Storage could not verify ${artifact.relativePath}`);
      }
    }
  }

  async deleteAttempt(prefix: string, signal: AbortSignal) {
    if (!/^media\/[a-z0-9-]+\/[a-z0-9-]+\/$/i.test(prefix)) {
      throw new Error("Invalid generated attempt prefix");
    }
    let continuation: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuation,
        }),
        { abortSignal: signal },
      );
      const objects =
        listed.Contents?.flatMap(({ Key }) =>
          Key && Key.startsWith(prefix) ? [{ Key }] : [],
        ) ?? [];
      if (objects.length) {
        const deleted = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
          { abortSignal: signal },
        );
        if (deleted.Errors?.length)
          throw new Error("Some unpublished media could not be removed");
      }
      continuation = listed.NextContinuationToken;
    } while (continuation);
  }
}
