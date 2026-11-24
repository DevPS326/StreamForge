import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Prisma } from "@streamforge/db";
import { SessionGuard, type AuthenticatedRequest } from "./auth";
import { Database } from "./database";

export const DEMO_MODE = process.env.DEMO_FREE_MODE === "1";
export const DEMO_FILE_BYTES = 20 * 1024 * 1024;
export const DEMO_STORAGE_BYTES = 200 * 1024 * 1024;
export const DEMO_MAX_QUEUE = 5;
export const DEMO_SLOT_MS = 2 * 60_000;
const DEMO_WORK_MS = 5 * 60_000;
const DEMO_DAY_UPLOADS = 5;
const DEMO_MONTH_UPLOADS = 50;
const DEMO_DAY_TURNS = 8;
const DEMO_MONTH_TURNS = 100;
const STALE_QUEUE_MS = 15 * 60_000;

// PostgreSQL advisory locks serialize admission and global quota reservations
// across multiple API instances; they are released on transaction completion.
const GATE_LOCK = 824120;
const STORAGE_LOCK = GATE_LOCK;

function quota(reason: string, message: string, retryAt: Date | null = null) {
  return new HttpException(
    { reason, message, retryAt: retryAt?.toISOString() ?? null },
    429,
  );
}

function resetAt(now: Date, monthly: boolean) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return monthly
    ? new Date(Date.UTC(year, month + 1, 1))
    : new Date(Date.UTC(year, month, now.getUTCDate() + 1));
}

@Injectable()
export class DemoGate {
  constructor(@Inject(Database) private readonly db: Database) {}

  private async coordinate(userId: string, join: boolean) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1::integer AS acquired FROM pg_advisory_xact_lock(${GATE_LOCK}::bigint)`;
      const now = new Date();
      await tx.demoTurn.deleteMany({
        where: {
          OR: [
            { expiresAt: { lte: now } },
            {
              expiresAt: null,
              joinedAt: { lt: new Date(+now - STALE_QUEUE_MS) },
            },
          ],
        },
      });
      let ticket = await tx.demoTurn.findUnique({ where: { userId } });
      let waiting = await tx.demoTurn.findMany({
        where: { expiresAt: null },
        orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
      });
      const active = await tx.demoTurn.findFirst({
        where: { expiresAt: { gt: now } },
      });
      if (!ticket && join) {
        if (waiting.length >= DEMO_MAX_QUEUE && active) {
          throw quota(
            "QUEUE_FULL",
            "The free demo waiting queue is full. Try again later.",
            new Date(+now + 30_000),
          );
        }
        ticket = await tx.demoTurn.create({ data: { userId } });
        waiting.push(ticket);
      }
      if (!active && waiting.length) {
        const dayKey = now.toISOString().slice(0, 10);
        const monthKey = dayKey.slice(0, 7);
        const usage = await tx.demoUsage.upsert({
          where: { id: 1 },
          create: { id: 1, dayKey, monthKey },
          update: {},
        });
        if (
          usage.monthKey === monthKey &&
          usage.monthUploads >= DEMO_MONTH_UPLOADS
        )
          throw quota(
            "MONTHLY_UPLOADS",
            "The monthly upload budget is exhausted.",
            resetAt(now, true),
          );
        if (usage.dayKey === dayKey && usage.dayUploads >= DEMO_DAY_UPLOADS)
          throw quota(
            "DAILY_UPLOADS",
            "The daily upload budget is exhausted.",
            resetAt(now, false),
          );
        const dayTurns = (usage.dayKey === dayKey ? usage.dayTurns : 0) + 1;
        const monthTurns =
          (usage.monthKey === monthKey ? usage.monthTurns : 0) + 1;
        if (monthTurns > DEMO_MONTH_TURNS)
          throw quota(
            "MONTHLY_TURNS",
            "The monthly demo turn budget is exhausted.",
            resetAt(now, true),
          );
        if (dayTurns > DEMO_DAY_TURNS)
          throw quota(
            "DAILY_TURNS",
            "The daily demo turn budget is exhausted.",
            resetAt(now, false),
          );
        await tx.demoUsage.update({
          where: { id: 1 },
          data: {
            dayKey,
            monthKey,
            dayTurns,
            monthTurns,
            dayUploads: usage.dayKey === dayKey ? usage.dayUploads : 0,
            monthUploads: usage.monthKey === monthKey ? usage.monthUploads : 0,
          },
        });
        const first = waiting[0]!;
        const until = new Date(+now + DEMO_WORK_MS);
        await tx.demoTurn.update({
          where: { userId: first.userId },
          data: { expiresAt: until },
        });
        if (first.userId === userId) ticket = { ...first, expiresAt: until };
        waiting = waiting.filter((item) => item.userId !== first.userId);
      }
      if (!ticket)
        return { state: "none" as const, position: 0, expiresAt: null };
      if (ticket.expiresAt && ticket.expiresAt > now)
        return {
          state: "active" as const,
          position: 0,
          expiresAt: ticket.expiresAt.toISOString(),
          stage: ticket.readyAt
            ? "download"
            : ticket.videoId
              ? "working"
              : "upload",
        };
      const position = waiting.findIndex((item) => item.userId === userId) + 1;
      return {
        state: "queued" as const,
        position: Math.max(1, position),
        expiresAt: null,
      };
    });
  }

  status(userId: string) {
    if (!DEMO_MODE)
      return Promise.resolve({
        state: "active" as const,
        position: 0,
        expiresAt: null,
      });
    return this.coordinate(userId, false);
  }

  join(userId: string) {
    if (!DEMO_MODE) return this.status(userId);
    return this.coordinate(userId, true);
  }

  async leave(userId: string) {
    if (!DEMO_MODE) return;
    // An unused turn has issued no upload or playback authorization.
    await this.db.demoTurn.deleteMany({
      where: {
        userId,
        OR: [
          { expiresAt: null },
          { expiresAt: { lte: new Date() } },
          { videoId: null },
        ],
      },
    });
  }

  async assertActive(
    userId: string,
    videoId?: string,
    ready = false,
  ): Promise<Date | undefined> {
    if (!DEMO_MODE) return;
    const turn = await this.db.demoTurn.findUnique({ where: { userId } });
    if (
      !turn?.expiresAt ||
      turn.expiresAt <= new Date() ||
      (videoId && turn.videoId !== videoId) ||
      (ready && !turn.readyAt)
    )
      throw new HttpException(
        "Your free demo slot has expired. Join the waiting queue.",
        429,
      );
    return turn.expiresAt;
  }

  async reserveMediaRequest(userId: string, videoId: string) {
    if (!DEMO_MODE) return;
    const result = await this.db.demoTurn.updateMany({
      where: {
        userId,
        videoId,
        readyAt: { not: null },
        expiresAt: { gt: new Date() },
        mediaReads: { lt: 100 },
      },
      data: { mediaReads: { increment: 1 } },
    });
    if (!result.count)
      throw new HttpException("Demo streaming request cap reached.", 429);
  }

  async reserveEgress(userId: string, videoId: string, bytes: number) {
    if (!DEMO_MODE) return;
    const limit = 128 * 1024 * 1024;
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > limit)
      throw new HttpException("Invalid demo transfer size", 429);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1::integer AS acquired FROM pg_advisory_xact_lock(${GATE_LOCK}::bigint)`;
      const now = new Date();
      const reserved = await tx.demoTurn.updateMany({
        where: {
          userId,
          videoId,
          readyAt: { not: null },
          expiresAt: { gt: now },
          egressBytes: { lte: limit - bytes },
        },
        data: { egressBytes: { increment: bytes } },
      });
      if (!reserved.count)
        throw new HttpException(
          "The demo transfer budget is exhausted or expired.",
          429,
        );
      const dayKey = now.toISOString().slice(0, 10);
      const monthKey = dayKey.slice(0, 7);
      const usage = await tx.demoTransferUsage.upsert({
        where: { id: 1 },
        create: { id: 1, dayKey, monthKey },
        update: {},
      });
      const dayBytes =
        (usage.dayKey === dayKey ? usage.dayBytes : 0n) + BigInt(bytes);
      const monthBytes =
        (usage.monthKey === monthKey ? usage.monthBytes : 0n) + BigInt(bytes);
      if (monthBytes > BigInt(limit) * BigInt(DEMO_MONTH_TURNS))
        throw quota(
          "MONTHLY_EGRESS",
          "The monthly demo transfer budget is exhausted.",
          resetAt(now, true),
        );
      if (dayBytes > BigInt(limit) * BigInt(DEMO_DAY_TURNS))
        throw quota(
          "DAILY_EGRESS",
          "The daily demo transfer budget is exhausted.",
          resetAt(now, false),
        );
      await tx.demoTransferUsage.update({
        where: { id: 1 },
        data: { dayKey, monthKey, dayBytes, monthBytes },
      });
    });
  }

  async reserveDownload(userId: string, videoId: string) {
    if (!DEMO_MODE) return;
    const result = await this.db.demoTurn.updateMany({
      where: {
        userId,
        videoId,
        readyAt: { not: null },
        expiresAt: { gt: new Date() },
        downloads: { lt: 1 },
      },
      data: { downloads: { increment: 1 } },
    });
    if (!result.count)
      throw new HttpException(
        "One private download per demo slot. Rejoin the queue to download again.",
        429,
      );
  }

  async reserveUpload(
    tx: Prisma.TransactionClient,
    userId: string,
    videoId: string,
    size: number,
  ) {
    if (!DEMO_MODE) return;
    if (size > DEMO_FILE_BYTES)
      throw new HttpException("Free demo limit: 20 MiB per video.", 413);
    await tx.$queryRaw`SELECT 1::integer AS acquired FROM pg_advisory_xact_lock(${STORAGE_LOCK}::bigint)`;
    const turn = await tx.demoTurn.findUnique({ where: { userId } });
    if (!turn?.expiresAt || turn.expiresAt <= new Date() || turn.videoId)
      throw new HttpException("An active demo turn allows one video.", 429);
    // Conservative 4x reservation covers an original plus its derived rendition.
    // All not-yet-cleaned video records count even when processing failed.
    const total = await tx.video.aggregate({
      where: { status: { not: "DELETED" } },
      _sum: { sizeBytes: true },
      _count: true,
    });
    const reserved =
      ((total._sum.sizeBytes ?? 0n) + BigInt(size)) * 4n +
      BigInt(total._count + 1) * 1048576n;
    if (reserved > BigInt(DEMO_STORAGE_BYTES))
      throw quota(
        "GLOBAL_STORAGE",
        "Global free-demo storage budget reached (200 MiB).",
      );
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    const monthKey = dayKey.slice(0, 7);
    const usage = await tx.demoUsage.upsert({
      where: { id: 1 },
      create: { id: 1, dayKey, monthKey, dayUploads: 0, monthUploads: 0 },
      update: {},
    });
    const dayUploads = (usage.dayKey === dayKey ? usage.dayUploads : 0) + 1;
    const monthUploads =
      (usage.monthKey === monthKey ? usage.monthUploads : 0) + 1;
    if (monthUploads > DEMO_MONTH_UPLOADS)
      throw quota(
        "MONTHLY_UPLOADS",
        "The monthly upload budget is exhausted.",
        resetAt(now, true),
      );
    if (dayUploads > DEMO_DAY_UPLOADS)
      throw quota(
        "DAILY_UPLOADS",
        "The daily upload budget is exhausted.",
        resetAt(now, false),
      );
    await tx.demoUsage.update({
      where: { id: 1 },
      data: {
        dayKey,
        monthKey,
        dayUploads,
        monthUploads,
        dayTurns: usage.dayKey === dayKey ? usage.dayTurns : 0,
        monthTurns: usage.monthKey === monthKey ? usage.monthTurns : 0,
      },
    });
    await tx.demoTurn.update({ where: { userId }, data: { videoId } });
    return turn.expiresAt;
  }
}

@Controller("demo")
@UseGuards(SessionGuard)
export class DemoController {
  constructor(@Inject(DemoGate) private readonly gate: DemoGate) {}

  @Get("status")
  status(@Req() request: AuthenticatedRequest) {
    return this.gate.status(request.auth.user.id);
  }

  @Post("join")
  join(@Req() request: AuthenticatedRequest) {
    return this.gate.join(request.auth.user.id);
  }

  @Delete("leave")
  @HttpCode(204)
  leave(@Req() request: AuthenticatedRequest) {
    return this.gate.leave(request.auth.user.id);
  }

  @Get("limits")
  limits() {
    return {
      fileBytes: DEMO_FILE_BYTES,
      globalReservedBytes: DEMO_STORAGE_BYTES,
      activeUsers: 1,
      waitingUsers: DEMO_MAX_QUEUE,
      slotSeconds: DEMO_SLOT_MS / 1000,
      uploadsPerDay: DEMO_DAY_UPLOADS,
      uploadsPerMonth: DEMO_MONTH_UPLOADS,
      mode: DEMO_MODE ? "free-demo" : "standard",
    };
  }
}
