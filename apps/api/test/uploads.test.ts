import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config";
import type { Database } from "../src/database";
import { DemoGate } from "../src/demo";
import { dispatchDelay } from "../src/outbox";
import type { Storage } from "../src/storage";
import {
  completeParts,
  expectedPartBytes,
  multipartLayout,
  Uploads,
  validatedMime,
} from "../src/uploads";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const config = parseConfig({
  DATABASE_URL: "postgresql://localhost/test",
  MEDIA_TOKEN_SECRET: "test-secret-not-valid-for-use-in-production",
  S3_BUCKET: "streamforge",
  SQS_QUEUE_URL: "http://localhost:9324/queue/test",
});

function fixture() {
  const userId = randomUUID();
  const videoId = randomUUID();
  const upload = {
    id: randomUUID(),
    filename: "demo.mov",
    requestKey: null,
    storageUploadId: "multipart-id",
    videoId,
    status: "ACTIVE",
    video: {
      id: videoId,
      userId,
      originalKey: `originals/${videoId}/source`,
      status: "UPLOADING",
      title: "Demo",
      mimeType: "video/quicktime",
      sizeBytes: 3n,
    },
    expiresAt: new Date(Date.now() + 60_000),
    updatedAt: new Date(),
    ...multipartLayout(3),
  };
  const job = { id: randomUUID(), videoId };
  const verifiedHead = {
    ContentLength: 3,
    ContentType: upload.video.mimeType,
    Metadata: { "upload-session": upload.id },
  };
  let stored: typeof verifiedHead | undefined;
  const storage = {
    parts: vi
      .fn()
      .mockResolvedValue([{ partNumber: 1, size: 3, etag: '"etag-one"' }]),
    head: vi.fn(async () => stored),
    complete: vi.fn(async () => {
      stored = verifiedHead;
    }),
    signPart: vi.fn().mockResolvedValue("http://localhost/part"),
  };
  const snapshot = () => ({ ...upload, video: { ...upload.video } });
  const db = {
    uploadSession: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === upload.id && where.video.userId === userId
          ? snapshot()
          : null,
      ),
      findUniqueOrThrow: vi.fn(async () => snapshot()),
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          where.id !== upload.id ||
          where.status !== upload.status ||
          (where.updatedAt &&
            where.updatedAt.getTime() !== upload.updatedAt.getTime())
        )
          return { count: 0 };
        upload.status = data.status;
        upload.updatedAt = data.updatedAt ?? new Date();
        return { count: 1 };
      }),
    },
    video: {
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.id !== videoId || where.status !== upload.video.status)
          return { count: 0 };
        Object.assign(upload.video, data);
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(async () => ({ ...upload.video })),
    },
    processingJob: { create: vi.fn().mockResolvedValue(job) },
    outbox: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(
      async (perform: (transaction: unknown) => Promise<unknown>) =>
        perform(db),
    ),
  };

  return {
    upload,
    userId,
    db,
    storage,
    job,
    verifiedHead,
    commitStorage: () => {
      stored = verifiedHead;
    },
    uploads: new Uploads(
      db as unknown as Database,
      new DemoGate(db as unknown as Database),
      storage as unknown as Storage,
      config,
    ),
  };
}

describe("multipart validation", () => {
  it("uses bounded S3-compatible layout including 1 GiB and the allowed maximum", () => {
    expect(multipartLayout(1)).toEqual({ partCount: 1, partSize: 8 * MIB });
    expect(multipartLayout(GIB)).toEqual({ partCount: 128, partSize: 8 * MIB });
    expect(multipartLayout(5 * 1024 * GIB).partCount).toBeLessThanOrEqual(
      10_000,
    );
    expect(expectedPartBytes(8 * MIB + 3, 8 * MIB, 2)).toBe(3);
  });

  it("checks browser MIME when present and validates fallback extensions", () => {
    expect(validatedMime("The river.MOV", "video/quicktime")).toBe(
      "video/quicktime",
    );
    expect(validatedMime("The river.M4V", "application/octet-stream")).toBe(
      "video/mp4",
    );
    expect(validatedMime("The river.MKV", "")).toBe("video/x-matroska");
    expect(() => validatedMime("The river.mp4", "image/png")).toThrow();
    expect(() => validatedMime("The river.html", "video/mp4")).toThrow();
    expect(() => validatedMime("constructor", "")).toThrow();
  });

  it("rejects missing, duplicate, reordered, or incorrectly sized upload parts", () => {
    const one = { partNumber: 1, etag: '"one"', size: 8 * MIB };
    const two = { partNumber: 2, etag: '"two"', size: 3 };
    expect(completeParts([one, two], 8 * MIB + 3, 8 * MIB, 2)).toBe(true);
    expect(completeParts([one], 8 * MIB + 3, 8 * MIB, 2)).toBe(false);
    expect(completeParts([one, one], 8 * MIB + 3, 8 * MIB, 2)).toBe(false);
    expect(completeParts([two, one], 8 * MIB + 3, 8 * MIB, 2)).toBe(false);
    expect(
      completeParts([one, { ...two, size: 12 }], 8 * MIB + 3, 8 * MIB, 2),
    ).toBe(false);
  });
});

describe("upload state transitions", () => {
  it("denies a different account from recovering or signing parts", async () => {
    const { upload, uploads, storage } = fixture();
    const otherUser = randomUUID();
    await expect(uploads.inspect(otherUser, upload.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(uploads.sign(otherUser, upload.id, [1])).rejects.toMatchObject(
      { status: 404 },
    );
    expect(storage.parts).not.toHaveBeenCalled();
    expect(storage.signPart).not.toHaveBeenCalled();
  });

  it("returns canonical parts and signs only declared part numbers at their expected size", async () => {
    const { upload, uploads, userId, storage } = fixture();
    await expect(uploads.inspect(userId, upload.id)).resolves.toMatchObject({
      parts: [{ partNumber: 1, size: 3, etag: '"etag-one"' }],
    });
    await expect(uploads.sign(userId, upload.id, [2])).rejects.toMatchObject({
      status: 400,
    });
    await expect(uploads.sign(userId, upload.id, [1, 1])).resolves.toEqual({
      urls: [{ partNumber: 1, url: "http://localhost/part" }],
    });
    expect(storage.signPart).toHaveBeenCalledExactlyOnceWith(
      upload.video.originalKey,
      upload.storageUploadId,
      1,
      3,
    );
  });

  it("releases the completion claim for missing parts without publishing a job", async () => {
    const { upload, uploads, userId, storage, db } = fixture();
    storage.parts.mockResolvedValueOnce([]);
    await expect(uploads.complete(userId, upload.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(upload.status).toBe("ACTIVE");
    expect(storage.complete).not.toHaveBeenCalled();
    expect(db.outbox.create).not.toHaveBeenCalled();
  });

  it("publishes one durable job when completion is delivered repeatedly", async () => {
    const { upload, uploads, userId, storage, db, job } = fixture();
    await expect(uploads.complete(userId, upload.id)).resolves.toMatchObject({
      id: upload.videoId,
      status: "PROCESSING",
    });
    await expect(uploads.complete(userId, upload.id)).resolves.toMatchObject({
      id: upload.videoId,
      status: "PROCESSING",
    });
    expect(upload.status).toBe("COMPLETED");
    expect(storage.complete).toHaveBeenCalledOnce();
    expect(db.processingJob.create).toHaveBeenCalledOnce();
    expect(db.outbox.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        kind: "PROCESS_VIDEO",
        videoId: upload.videoId,
        payload: { jobId: job.id, videoId: upload.videoId },
      },
    });
  });

  it("recovers when storage completion succeeded but its response was lost", async () => {
    const { upload, uploads, userId, storage, commitStorage, db } = fixture();
    storage.complete.mockImplementationOnce(async () => {
      commitStorage();
      throw new Error("connection dropped");
    });
    await expect(uploads.complete(userId, upload.id)).resolves.toMatchObject({
      status: "PROCESSING",
    });
    expect(db.processingJob.create).toHaveBeenCalledOnce();
  });

  it("keeps a recoverable claim during a temporary storage outage and finishes after the fence expires", async () => {
    const { upload, uploads, userId, storage, db } = fixture();
    storage.parts.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(uploads.complete(userId, upload.id)).rejects.toMatchObject({
      status: 503,
    });
    expect(upload.status).toBe("COMPLETING");
    expect(db.outbox.create).not.toHaveBeenCalled();
    await expect(uploads.cancel(userId, upload.id)).rejects.toMatchObject({
      status: 409,
    });

    upload.updatedAt = new Date(Date.now() - 6 * 60_000);
    await expect(uploads.complete(userId, upload.id)).resolves.toMatchObject({
      status: "PROCESSING",
    });
    expect(storage.complete).toHaveBeenCalledOnce();
    expect(db.outbox.create).toHaveBeenCalledOnce();
  });

  it("reconciles an already completed object after the publish transaction was unavailable", async () => {
    const { upload, uploads, userId, storage, db } = fixture();
    db.$transaction.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(uploads.complete(userId, upload.id)).rejects.toThrow(
      "database unavailable",
    );
    expect(upload.status).toBe("COMPLETING");
    await expect(uploads.complete(userId, upload.id)).resolves.toMatchObject({
      status: "PROCESSING",
    });
    expect(storage.complete).toHaveBeenCalledOnce();
    expect(db.outbox.create).toHaveBeenCalledOnce();
  });

  it("rejects the wrong completed object and durably records cleanup", async () => {
    const { upload, uploads, userId, storage, db, verifiedHead } = fixture();
    storage.head.mockResolvedValueOnce({
      ...verifiedHead,
      Metadata: { "upload-session": randomUUID() },
    });
    await expect(uploads.complete(userId, upload.id)).rejects.toMatchObject({
      status: 400,
    });
    expect(db.processingJob.create).not.toHaveBeenCalled();
    expect(upload.status).toBe("ABORTING");
    expect(upload.video.status).toBe("FAILED");
    expect(db.outbox.create).toHaveBeenCalledExactlyOnceWith({
      data: { kind: "CLEANUP_VIDEO", videoId: upload.videoId, payload: {} },
    });
  });

  it("fences cancel against claimed completion and makes repeated cancellation idempotent", async () => {
    const { upload, uploads, userId, db } = fixture();
    upload.status = "COMPLETING";
    await expect(uploads.cancel(userId, upload.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(db.outbox.create).not.toHaveBeenCalled();
    upload.status = "ACTIVE";
    await uploads.cancel(userId, upload.id);
    await uploads.cancel(userId, upload.id);
    expect(upload.status).toBe("ABORTING");
    expect(upload.video.status).toBe("DELETING");
    expect(db.outbox.create).toHaveBeenCalledOnce();
  });
});

describe("outbox retry policy", () => {
  it("backs off with jitter and caps the retry delay", () => {
    expect(dispatchDelay(2, 0)).toBe(2_000);
    expect(dispatchDelay(2, 0.75)).toBe(5_000);
    expect(dispatchDelay(3, 0.75)).toBe(10_000);
    expect(dispatchDelay(50, 0.75)).toBe(300_000);
  });
});
