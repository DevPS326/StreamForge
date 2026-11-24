import {
  ConflictException,
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
const DEMO_DAY_UPLOADS = 5;
const DEMO_MONTH_UPLOADS = 50;
const STALE_QUEUE_MS = 15 * 60_000;

// PostgreSQL advisory locks serialize admission and global quota reservations
// across multiple API instances; they are released on transaction completion.
const GATE_LOCK = 824120;
const STORAGE_LOCK = 824121;

@Injectable()
export class DemoGate {
  constructor(@Inject(Database) private readonly db: Database) {}

  private async coordinate(userId: string, join: boolean) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${GATE_LOCK})`;
      const now = new Date();
      await tx.demoTurn.deleteMany({
        where: {
          OR: [
            { expiresAt: { lte: now } },
            { expiresAt: null, joinedAt: { lt: new Date(+now - STALE_QUEUE_MS) } },
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
          throw new HttpException("The free demo waiting queue is full. Try again later.", 429);
        }
        ticket = await tx.demoTurn.create({ data: { userId } });
        waiting.push(ticket);
      }
      if (!active && waiting.length) {
        const first = waiting[0]!;
        const until = new Date(+now + DEMO_SLOT_MS);
        await tx.demoTurn.update({
          where: { userId: first.userId },
          data: { expiresAt: until },
        });
        if (first.userId === userId)
          ticket = { ...first, expiresAt: until };
        waiting = waiting.filter((item) => item.userId !== first.userId);
      }
      if (!ticket) return { state: "none" as const, position: 0, expiresAt: null };
      if (ticket.expiresAt && ticket.expiresAt > now)
        return { state: "active" as const, position: 0, expiresAt: ticket.expiresAt.toISOString() };
      const position = waiting.findIndex((item) => item.userId === userId) + 1;
      return { state: "queued" as const, position: Math.max(1, position), expiresAt: null };
    });
  }

  status(userId: string) {
    if (!DEMO_MODE) return Promise.resolve({ state: "active" as const, position: 0, expiresAt: null });
    return this.coordinate(userId, false);
  }

  join(userId: string) {
    if (!DEMO_MODE) return this.status(userId);
    return this.coordinate(userId, true);
  }

  async leave(userId: string) {
    if (!DEMO_MODE) return;
    await this.db.demoTurn.deleteMany({ where: { userId } });
  }

  async assertActive(userId: string): Promise<Date | undefined> {
    if (!DEMO_MODE) return;
    const turn = await this.db.demoTurn.findUnique({ where: { userId } });
    if (!turn?.expiresAt || turn.expiresAt <= new Date())
      throw new HttpException("Your free demo slot has expired. Join the waiting queue.", 429);
    return turn.expiresAt;
  }

  async reserveUpload(tx: Prisma.TransactionClient, size: number) {
    if (!DEMO_MODE) return;
    if (size > DEMO_FILE_BYTES)
      throw new HttpException("Free demo limit: 20 MiB per video.", 413);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${STORAGE_LOCK})`;
    // Conservative 4x reservation covers an original plus its derived rendition.
    // All not-yet-cleaned video records count even when processing failed.
    const total = await tx.video.aggregate({
      where: { status: { not: "DELETED" } },
      _sum: { sizeBytes: true },
    });
    const reserved = ((total._sum.sizeBytes ?? 0n) + BigInt(size)) * 4n;
    if (reserved > BigInt(DEMO_STORAGE_BYTES))
      throw new ConflictException("Global free-demo storage budget reached (200 MiB).");
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    const monthKey = dayKey.slice(0, 7);
    const usage = await tx.demoUsage.upsert({
      where: { id: 1 },
      create: { id: 1, dayKey, monthKey, dayUploads: 0, monthUploads: 0 },
      update: {},
    });
    const dayUploads = (usage.dayKey === dayKey ? usage.dayUploads : 0) + 1;
    const monthUploads = (usage.monthKey === monthKey ? usage.monthUploads : 0) + 1;
    if (dayUploads > DEMO_DAY_UPLOADS || monthUploads > DEMO_MONTH_UPLOADS)
      throw new HttpException("Free demo upload quota reached. Try in a later quota window.", 429);
    await tx.demoUsage.update({
      where: { id: 1 },
      data: { dayKey, monthKey, dayUploads, monthUploads },
    });
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
