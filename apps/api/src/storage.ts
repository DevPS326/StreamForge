import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import {
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import { API_CONFIG, type ApiConfig } from "./config";

export function storageStatus(error: unknown, name: string, status?: number) {
  if (!(error instanceof Error)) return false;
  const metadata = (
    error as Error & { $metadata?: { httpStatusCode?: number } }
  ).$metadata;
  return (
    error.name === name ||
    (status !== undefined && metadata?.httpStatusCode === status)
  );
}

export type StoredPart = { partNumber: number; etag: string; size: number };

@Injectable()
export class Storage implements OnApplicationShutdown {
  private readonly s3: S3Client;
  private readonly presigner: S3Client;
  private readonly sqs: SQSClient;
  private readonly bucket: string;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {
    this.bucket = config.S3_BUCKET;
    this.s3 = this.s3Client(config.S3_ENDPOINT);
    this.presigner = this.s3Client(
      config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT,
    );
    this.sqs = new SQSClient({
      region: config.S3_REGION,
      endpoint: config.SQS_ENDPOINT,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 20_000 },
    });
  }

  private s3Client(endpoint?: string) {
    return new S3Client({
      region: this.config.S3_REGION,
      endpoint,
      forcePathStyle: Boolean(endpoint),
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    });
  }

  onApplicationShutdown() {
    this.s3.destroy();
    this.presigner.destroy();
    this.sqs.destroy();
  }

  async ready() {
    const abortSignal = AbortSignal.timeout(4000);
    if (process.env.DEMO_FREE_MODE === "1") {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }), {
        abortSignal,
      });
      return;
    }
    await Promise.all([
      this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }), {
        abortSignal,
      }),
      this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.config.SQS_QUEUE_URL,
          AttributeNames: ["QueueArn"],
        }),
        { abortSignal },
      ),
    ]);
  }

  async begin(key: string, mimeType: string, sessionId: string) {
    const result = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: mimeType,
        Metadata: { "upload-session": sessionId },
      }),
    );
    if (!result.UploadId)
      throw new Error("Storage did not return a multipart upload identifier");
    return result.UploadId;
  }

  signPart(
    key: string,
    uploadId: string,
    partNumber: number,
    size: number,
    ttlSeconds = 900,
  ) {
    return getSignedUrl(
      this.presigner,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: size,
      }),
      { expiresIn: ttlSeconds, signableHeaders: new Set(["content-length"]) },
    );
  }

  signDownload(key: string, filename: string, ttlSeconds: number) {
    const safe =
      filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "video.mp4";
    return getSignedUrl(
      this.presigner,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safe}"`,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async parts(key: string, uploadId: string) {
    const parts: StoredPart[] = [];
    let marker: string | undefined;
    for (let index = 0; index < 10; index++) {
      const page = await this.s3.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MaxParts: 1000,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        if (
          part.PartNumber === undefined ||
          part.ETag === undefined ||
          part.Size === undefined
        ) {
          throw new Error("Storage returned invalid multipart metadata");
        }
        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          size: part.Size,
        });
      }
      if (parts.length > 10_000) {
        throw new Error("Storage returned too many multipart parts");
      }
      if (page.IsTruncated !== true) {
        return parts.sort(
          (first, second) => first.partNumber - second.partNumber,
        );
      }
      const next = page.NextPartNumberMarker;
      if (
        !next ||
        !/^\d{1,5}$/.test(next) ||
        Number(next) <= Number(marker ?? "0") ||
        Number(next) > 10_000
      ) {
        throw new Error(
          "Storage returned an invalid multipart pagination marker",
        );
      }
      marker = next;
    }
    throw new Error("Storage exceeded the multipart pagination limit");
  }

  async complete(key: string, uploadId: string, parts: StoredPart[]) {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map(({ etag, partNumber }) => ({
            ETag: etag,
            PartNumber: partNumber,
          })),
        },
      }),
    );
  }

  async head(key: string) {
    try {
      return await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      if (storageStatus(error, "NotFound", 404)) return undefined;
      throw error;
    }
  }

  async abort(key: string, uploadId: string) {
    try {
      await this.s3.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (!storageStatus(error, "NoSuchUpload", 404)) throw error;
    }
  }

  get(key: string, range?: string, signal?: AbortSignal) {
    return this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: range,
      }),
      { abortSignal: signal },
    );
  }

  async remove(key: string) {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async removePrefix(prefix: string) {
    // Restart at the first page after deletion so keys inserted during cleanup can also be observed.
    for (let batch = 0; batch < 100; batch++) {
      const result = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: 1000,
        }),
      );
      const keys = (result.Contents ?? []).flatMap(({ Key }) =>
        Key ? [{ Key }] : [],
      );
      if (!keys.length) return;
      const removed = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys, Quiet: true },
        }),
      );
      if (removed.Errors?.length)
        throw new Error("Storage failed to delete one or more media assets");
    }
    throw new Error("Storage cleanup requires an additional pass");
  }

  async enqueue(jobId: string, videoId: string) {
    // ProcessingJob is already committed transactionally; local worker polls it.
    if (process.env.DEMO_FREE_MODE === "1") return;
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.config.SQS_QUEUE_URL,
        MessageBody: JSON.stringify({ jobId, videoId }),
      }),
    );
  }
}
