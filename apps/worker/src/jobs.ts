import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@streamforge/db";
import { type EncodedMedia, MediaError } from "./media.js";
import { errorText } from "./log.js";

export type QueueJob = { jobId: string; videoId: string };
export type ClaimedJob = QueueJob & {
  leaseToken: string;
  initialLeaseDeadline: Date;
  previousToken: string | null;
  attempts: number;
  originalKey: string;
  sizeBytes: bigint;
  demoExpiresAt?: Date;
};

export type QueueAction =
  | { kind: "ack"; reapPrefix?: string }
  | { kind: "defer"; seconds: number }
  | { kind: "redeliver" };
type ClaimResult = QueueAction | { kind: "claimed"; job: ClaimedJob };

export function parseQueueJob(body: string | undefined): QueueJob | null {
  if (!body || body.length > 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const { jobId, videoId } = parsed as Partial<QueueJob>;
  const valid = (id: unknown): id is string =>
    typeof id === "string" && /^[a-z0-9-]{1,80}$/i.test(id);
  return valid(jobId) && valid(videoId) ? { jobId, videoId } : null;
}

export function retryDelaySeconds(
  attempt: number,
  random = Math.random,
): number {
  return Math.min(
    600,
    Math.max(
      1,
      Math.round(15 * 2 ** Math.max(0, attempt - 1) * (0.75 + random() / 2)),
    ),
  );
}

export function attemptPrefix(videoId: string, leaseToken: string): string {
  return `media/${videoId}/${leaseToken}/`;
}

function getEligible(now: Date): Prisma.ProcessingJobWhereInput[] {
  return [
    { status: "PENDING", nextAttemptAt: { lte: now } },
    {
      status: "RUNNING",
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
  ];
}

export class JobRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly leaseSeconds: number,
    private readonly maxAttempts: number,
  ) {}

  async claim(message: QueueJob): Promise<ClaimResult> {
    const now = new Date();
    const found = await this.db.processingJob.findUnique({
      where: { id: message.jobId },
      include: {
        video: {
          select: {
            status: true,
            originalKey: true,
            sizeBytes: true,
            demoExpiresAt: true,
          },
        },
      },
    });
    if (!found || found.videoId !== message.videoId) return { kind: "ack" };

    if (
      found.video.status !== "PROCESSING" ||
      (found.status !== "PENDING" && found.status !== "RUNNING")
    ) {
      return { kind: "ack" };
    }
    if (
      process.env.DEMO_FREE_MODE === "1" &&
      (!found.video.demoExpiresAt || found.video.demoExpiresAt <= now)
    )
      return { kind: "ack" };
    const eligibleAt =
      found.status === "PENDING" ? found.nextAttemptAt : found.leaseExpiresAt;
    if (eligibleAt && eligibleAt > now) {
      return {
        kind: "defer",
        seconds: Math.min(
          900,
          Math.max(1, Math.ceil((+eligibleAt - +now) / 1000)),
        ),
      };
    }

    const where = {
      id: found.id,
      videoId: found.videoId,
      attempts: found.attempts,
      video: { status: "PROCESSING" as const },
      OR: getEligible(now),
    };

    if (found.attempts >= this.maxAttempts) {
      const transitioned = await this.transitionFailure(
        where,
        message.videoId,
        "PROCESSING_FAILED",
        "Processing lease expired after the final attempt",
      );
      if (!transitioned) return { kind: "defer", seconds: 10 };
      return {
        kind: "ack",
        reapPrefix: found.leaseToken
          ? attemptPrefix(message.videoId, found.leaseToken)
          : undefined,
      };
    }

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(+now + this.leaseSeconds * 1000);
    const claimed = await this.db.processingJob.updateMany({
      where,
      data: {
        status: "RUNNING",
        attempts: { increment: 1 },
        leaseToken,
        leaseExpiresAt,
      },
    });
    if (!claimed.count) return { kind: "defer", seconds: 10 };

    return {
      kind: "claimed",
      job: {
        ...message,
        leaseToken,
        initialLeaseDeadline: leaseExpiresAt,
        previousToken: found.leaseToken,
        attempts: found.attempts + 1,
        originalKey: found.video.originalKey,
        sizeBytes: found.video.sizeBytes,
        demoExpiresAt: found.video.demoExpiresAt ?? undefined,
      },
    };
  }

  private claimedWhere(
    job: ClaimedJob,
    now: Date,
  ): Prisma.ProcessingJobWhereInput {
    return {
      id: job.jobId,
      videoId: job.videoId,
      status: "RUNNING",
      leaseToken: job.leaseToken,
      leaseExpiresAt: { gt: now },
      video: { status: "PROCESSING" },
    };
  }

  async renew(job: ClaimedJob): Promise<Date | false> {
    const now = new Date();
    const leaseExpiresAt = new Date(+now + this.leaseSeconds * 1000);
    const result = await this.db.processingJob.updateMany({
      where: this.claimedWhere(job, now),
      data: { leaseExpiresAt },
    });
    return result.count === 1 && leaseExpiresAt;
  }

  async publish(job: ClaimedJob, media: EncodedMedia): Promise<boolean> {
    const prefix = attemptPrefix(job.videoId, job.leaseToken);
    return this.db.$transaction(async (tx) => {
      // Acquire the processing job before the video, matching the API deletion transaction.
      const processing = await tx.processingJob.updateMany({
        where: this.claimedWhere(job, new Date()),
        data: {
          status: "SUCCEEDED",
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      });
      if (!processing.count) return false;

      let demoExpiresAt: Date | undefined;
      if (process.env.DEMO_FREE_MODE === "1") {
        const readyAt = new Date();
        demoExpiresAt = new Date(+readyAt + 120_000);
        const turn = await tx.demoTurn.updateMany({
          where: {
            videoId: job.videoId,
            readyAt: null,
            expiresAt: { gt: readyAt },
          },
          data: { readyAt, expiresAt: demoExpiresAt },
        });
        if (!turn.count) throw new Error("Demo work window expired");
      }
      const video = await tx.video.updateMany({
        where: { id: job.videoId, status: "PROCESSING" },
        data: {
          status: "READY",
          demoExpiresAt,
          mediaPrefix: prefix.slice(0, -1),
          width: media.source.width,
          height: media.source.height,
          durationSeconds: media.source.durationSeconds,
          failureCode: null,
        },
      });
      if (!video.count)
        throw new Error("Video state changed during publication");

      await tx.videoAsset.createMany({
        data: [
          { videoId: job.videoId, kind: "MASTER", key: prefix + "master.m3u8" },
          {
            videoId: job.videoId,
            kind: "THUMBNAIL",
            key: prefix + "poster.jpg",
          },
          ...media.variants.map((variant) => ({
            videoId: job.videoId,
            kind: "VARIANT" as const,
            key: prefix + variant.relativePath,
            width: variant.width,
            height: variant.height,
            bitrate: variant.peakBandwidth,
          })),
        ],
      });
      return true;
    });
  }

  async failure(job: ClaimedJob, error: unknown): Promise<QueueAction> {
    const now = new Date();
    const where = this.claimedWhere(job, now);
    if (error instanceof MediaError || job.attempts >= this.maxAttempts) {
      const code =
        error instanceof MediaError ? error.code : "PROCESSING_FAILED";
      const result = await this.transitionFailure(
        where,
        job.videoId,
        code,
        errorText(error),
      );
      return result ? { kind: "ack" } : { kind: "redeliver" };
    }

    const seconds = retryDelaySeconds(job.attempts);
    const updated = await this.db.processingJob.updateMany({
      where,
      // Retaining the old token lets the next attempt reap objects left by a terminated process.
      data: {
        status: "PENDING",
        nextAttemptAt: new Date(+now + seconds * 1000),
        leaseExpiresAt: null,
        lastError: errorText(error),
      },
    });
    return updated.count ? { kind: "defer", seconds } : { kind: "redeliver" };
  }

  private async transitionFailure(
    where: Prisma.ProcessingJobWhereInput,
    videoId: string,
    failureCode: string,
    lastError: string,
  ): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const result = await tx.processingJob.updateMany({
        where,
        data: { status: "FAILED", leaseExpiresAt: null, lastError },
      });
      if (!result.count) return false;
      const video = await tx.video.updateMany({
        where: { id: videoId, status: "PROCESSING" },
        data: { status: "FAILED", failureCode },
      });
      if (!video.count)
        throw new Error("Video state changed during failure transition");
      return true;
    });
  }

  async isPublished(videoId: string, prefix: string): Promise<boolean> {
    const video = await this.db.video.findUnique({
      where: { id: videoId },
      select: { mediaPrefix: true, status: true },
    });
    return (
      video?.status === "READY" && video.mediaPrefix === prefix.slice(0, -1)
    );
  }
}
