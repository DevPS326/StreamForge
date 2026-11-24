import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import type { Outbox, Prisma } from "@streamforge/db";
import { z } from "zod";
import { Database } from "./database";
import { Storage } from "./storage";
import { Uploads } from "./uploads";

const LEASE_MS = 120_000;
const POLL_MS = 1_000;
const RECONCILE_MS = 60_000;
const PROCESSING_QUIET_MS = 5 * 60_000;
const processPayload = z.object({ jobId: z.uuid(), videoId: z.uuid() });

export function dispatchDelay(attempt: number, random = Math.random()) {
  return Math.min(300_000, 1000 * 2 ** Math.min(attempt, 9) * (0.5 + random));
}

@Injectable()
export class OutboxDispatcher
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly log = new Logger(OutboxDispatcher.name);
  private timer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private reconciling: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Storage) private readonly storage: Storage,
    @Inject(Uploads) private readonly uploads: Uploads,
  ) {}

  onApplicationBootstrap() {
    this.polling = this.poll();
    this.reconciling = this.reconcile();
  }

  async onModuleDestroy() {
    this.stopping = true;
    clearTimeout(this.timer);
    clearTimeout(this.reconcileTimer);
    const timeout = new AbortController();
    try {
      await Promise.race([
        Promise.allSettled([this.polling, this.reconciling]),
        delay(5_000, undefined, { signal: timeout.signal }),
      ]);
    } finally {
      timeout.abort();
    }
  }

  private async poll() {
    try {
      const now = new Date();
      const available: Prisma.OutboxWhereInput = {
        sentAt: null,
        availableAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      };
      const records = await this.db.outbox.findMany({
        where: available,
        take: 8,
        orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
      });
      for (
        let offset = 0;
        offset < records.length && !this.stopping;
        offset += 4
      ) {
        await Promise.allSettled(
          records
            .slice(offset, offset + 4)
            .map((record) => this.dispatch(record, available)),
        );
      }
    } catch (error) {
      this.log.warn({
        event: "outbox_poll_failed",
        error: error instanceof Error ? error.name : "Unknown",
      });
    } finally {
      if (!this.stopping)
        this.timer = setTimeout(() => {
          this.polling = this.poll();
        }, POLL_MS).unref();
    }
  }

  private async dispatch(record: Outbox, available: Prisma.OutboxWhereInput) {
    const leaseToken = randomUUID();
    try {
      const claimed = await this.db.outbox.updateMany({
        where: { id: record.id, ...available },
        data: {
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          attempts: { increment: 1 },
        },
      });
      if (!claimed.count) return;
      if (record.kind === "PROCESS_VIDEO") {
        const payload = processPayload.parse(record.payload);
        if (payload.videoId !== record.videoId)
          throw new Error("Invalid processing dispatch record");
        await this.storage.enqueue(payload.jobId, payload.videoId);
      } else {
        await this.cleanup(record.videoId);
      }
      await this.db.outbox.updateMany({
        where: { id: record.id, leaseToken },
        data: {
          sentAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      });
    } catch (error) {
      const lastError = error instanceof Error ? error.name : "Unknown";
      this.log.warn({
        event: "outbox_dispatch_failed",
        outboxId: record.id,
        videoId: record.videoId,
        kind: record.kind,
        error: lastError,
      });
      await this.db.outbox
        .updateMany({
          where: { id: record.id, leaseToken },
          data: {
            availableAt: new Date(
              Date.now() + dispatchDelay(record.attempts + 1),
            ),
            leaseToken: null,
            leaseExpiresAt: null,
            lastError,
          },
        })
        .catch(() => {
          this.log.warn({
            event: "outbox_retry_persist_failed",
            outboxId: record.id,
          });
        });
    }
  }

  private async cleanup(videoId: string) {
    const video = await this.db.video.findUnique({
      where: { id: videoId },
      select: {
        status: true,
        originalKey: true,
        failureCode: true,
        upload: { select: { id: true, status: true, storageUploadId: true } },
      },
    });
    if (
      !video ||
      (video.status !== "DELETING" &&
        !(video.status === "FAILED" && video.failureCode === "UPLOAD_INVALID"))
    )
      return;
    if (video.upload?.storageUploadId && video.upload.status === "ABORTING") {
      await this.storage.abort(video.originalKey, video.upload.storageUploadId);
    }
    await Promise.all([
      this.storage.remove(video.originalKey),
      this.storage.removePrefix(`media/${videoId}/`),
    ]);
    await this.db.$transaction(async (tx) => {
      await tx.uploadSession.updateMany({
        where: { videoId, status: "ABORTING" },
        data: { status: "ABORTED", storageUploadId: null },
      });
      await tx.videoAsset.deleteMany({ where: { videoId } });
      await tx.video.updateMany({
        where: { id: videoId, status: "DELETING" },
        data: { status: "DELETED", mediaPrefix: null },
      });
    });
  }

  private async reconcile() {
    try {
      const results = await Promise.allSettled([
        this.uploads.reconcile(),
        this.reconcileProcessing(),
      ]);
      for (const result of results) {
        if (result.status === "rejected") {
          this.log.warn({
            event: "reconciliation_failed",
            error:
              result.reason instanceof Error ? result.reason.name : "Unknown",
          });
        }
      }
    } finally {
      if (!this.stopping)
        this.reconcileTimer = setTimeout(() => {
          this.reconciling = this.reconcile();
        }, RECONCILE_MS).unref();
    }
  }

  private async reconcileProcessing() {
    const now = new Date();
    const eligible: Prisma.ProcessingJobWhereInput = {
      updatedAt: { lte: new Date(now.getTime() - PROCESSING_QUIET_MS) },
      OR: [
        { status: "PENDING", nextAttemptAt: { lte: now } },
        { status: "RUNNING", leaseExpiresAt: { lte: now } },
      ],
      video: {
        status: "PROCESSING",
        outbox: { none: { kind: "PROCESS_VIDEO", sentAt: null } },
      },
    };
    const candidates = await this.db.processingJob.findMany({
      where: eligible,
      orderBy: { updatedAt: "asc" },
      take: 25,
      select: { id: true, videoId: true },
    });
    for (const candidate of candidates) {
      if (this.stopping) break;
      await this.db.$transaction(async (tx) => {
        const claimed = await tx.processingJob.updateMany({
          where: { id: candidate.id, ...eligible },
          data: { updatedAt: now },
        });
        if (!claimed.count) return;
        await tx.outbox.create({
          data: {
            kind: "PROCESS_VIDEO",
            videoId: candidate.videoId,
            payload: { jobId: candidate.id, videoId: candidate.videoId },
          },
        });
      });
    }
  }
}
