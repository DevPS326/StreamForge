import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import type { Prisma, Video } from "@streamforge/db";
import { z } from "zod";
import type { Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  SessionGuard,
  digest,
  newSecret,
  type AuthenticatedRequest,
} from "./auth";
import { Database } from "./database";
import { VideoPresenter } from "./media";
import { DemoGate, DEMO_MODE } from "./demo";
import { Storage } from "./storage";
import { Uploads } from "./uploads";
import {
  documentedBody,
  opaqueSecret,
  title,
  uuid,
  validate,
} from "./validation";

const visible: Prisma.VideoWhereInput = {
  status: { notIn: ["DELETING", "DELETED"] },
};
const shareState = {
  shares: { where: { revokedAt: null }, take: 1, select: { id: true } },
} as const;
const sorts = ["newest", "oldest", "title", "largest"] as const;
const browse = z.object({
  search: z.string().trim().max(100).default(""),
  sort: z.enum(sorts).default("newest"),
  limit: z
    .union([
      z
        .string()
        .regex(/^\d{1,2}$/)
        .transform(Number),
      z.number(),
    ])
    .pipe(z.number().int().min(1).max(50))
    .default(24),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(850)
    .optional(),
});
const renameBody = z.object({ title });
type Sort = (typeof sorts)[number];
type Cursor = { id: string; sort: Sort; value: string };
const cursorSchema = z.object({
  id: uuid,
  sort: z.enum(sorts),
  value: z.string().max(160),
});

const order: Record<Sort, Prisma.VideoOrderByWithRelationInput[]> = {
  newest: [{ createdAt: "desc" }, { id: "desc" }],
  oldest: [{ createdAt: "asc" }, { id: "asc" }],
  title: [{ title: "asc" }, { id: "asc" }],
  largest: [{ sizeBytes: "desc" }, { id: "desc" }],
};

function encodeCursor(video: Video, sort: Sort) {
  const value = {
    newest: video.createdAt.toISOString(),
    oldest: video.createdAt.toISOString(),
    title: video.title,
    largest: video.sizeBytes.toString(),
  }[sort];
  return Buffer.from(
    JSON.stringify({ id: video.id, sort, value }),
    "utf8",
  ).toString("base64url");
}

export function afterCursor(
  encoded: string | undefined,
  sort: Sort,
): Prisma.VideoWhereInput {
  if (!encoded) return {};
  let cursor: Cursor;
  try {
    cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch {
    throw new BadRequestException("Invalid page cursor");
  }
  if (cursor.sort !== sort)
    throw new BadRequestException(
      "The page cursor does not match the current sort",
    );
  const { value, id } = cursor;
  if (sort === "title") {
    return { OR: [{ title: { gt: value } }, { title: value, id: { gt: id } }] };
  }
  if (sort === "largest") {
    if (!/^\d{1,15}$/.test(value))
      throw new BadRequestException("Invalid page cursor");
    const bytes = BigInt(value);
    return {
      OR: [{ sizeBytes: { lt: bytes } }, { sizeBytes: bytes, id: { lt: id } }],
    };
  }
  const date = new Date(validate(z.iso.datetime(), value));
  const op = sort === "oldest" ? "gt" : "lt";
  return {
    OR: [{ createdAt: { [op]: date } }, { createdAt: date, id: { [op]: id } }],
  };
}

@ApiTags("Videos")
@ApiCookieAuth("sf_session")
@UseGuards(SessionGuard)
@Controller("videos")
export class VideoController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(DemoGate) private readonly gate: DemoGate,
    @Inject(Storage) private readonly storage: Storage,
    @Inject(VideoPresenter) private readonly presenter: VideoPresenter,
    @Inject(Uploads) private readonly uploads: Uploads,
  ) {}

  @Get()
  @ApiQuery({ name: "search", required: false, type: String })
  @ApiQuery({ name: "sort", required: false, enum: [...sorts] })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    minimum: 1,
    maximum: 50,
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOperation({
    summary:
      "List the signed-in account’s videos with stable keyset pagination",
  })
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const { search, sort, limit, cursor } = validate(browse, query);
    const items = await this.db.video.findMany({
      where: {
        userId: request.auth.user.id,
        ...visible,
        title: search
          ? { contains: search.replace(/[\\%_]/g, "\\$&"), mode: "insensitive" }
          : undefined,
        ...afterCursor(cursor, sort),
      },
      include: shareState,
      orderBy: order[sort],
      take: limit + 1,
    });
    const more = items.length > limit;
    const page = more ? items.slice(0, limit) : items;
    return {
      items: page.map((video) =>
        this.presenter.video(video, null, video.shares.length > 0),
      ),
      nextCursor: more ? encodeCursor(page[page.length - 1], sort) : null,
    };
  }

  @Get(":id")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({
    summary: "Read an owned video and obtain fresh playback authorization",
  })
  async get(
    @Req() request: AuthenticatedRequest,
    @Param("id") idParam: string,
  ) {
    const id = validate(uuid, idParam);
    const video = await this.db.video.findFirst({
      where: { id, userId: request.auth.user.id, ...visible },
      include: shareState,
    });
    if (!video) throw new NotFoundException("Video not found");
    return this.presenter.video(video, null, video.shares.length > 0);
  }

  @Get(":id/download")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({
    summary: "Issue private download access bounded by the active demo slot",
  })
  async download(
    @Req() request: AuthenticatedRequest,
    @Param("id") idParam: string,
  ) {
    const id = validate(uuid, idParam);
    const video = await this.db.video.findFirst({
      where: { id, userId: request.auth.user.id, status: "READY" },
      select: { id: true },
    });
    if (!video) throw new NotFoundException("Processed video is not ready");
    const ends = await this.gate.assertActive(request.auth.user.id);
    const seconds = ends ? Math.floor((+ends - Date.now()) / 1000) : 120;
    if (seconds < 1) throw new ConflictException("Your download slot expired");
    return {
      url: `/api/v1/videos/${id}/download-file`,
      expiresInSeconds: Math.min(120, seconds),
    };
  }

  @Get(":id/download-file")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({
    summary: "Metered private download, limited to one request per demo slot",
  })
  async downloadFile(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
    @Param("id") idParam: string,
  ) {
    const id = validate(uuid, idParam);
    const video = await this.db.video.findFirst({
      where: { id, userId: request.auth.user.id, status: "READY" },
      select: {
        originalKey: true,
        title: true,
        mimeType: true,
        sizeBytes: true,
      },
    });
    if (!video) throw new NotFoundException("Processed video is not ready");
    await this.gate.assertActive(request.auth.user.id);
    await this.gate.reserveDownload(request.auth.user.id);
    const object = await this.storage.get(video.originalKey);
    if (!(object.Body instanceof Readable))
      throw new ConflictException("Video download is not available");
    const filename =
      video.title.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "video";
    response.setHeader("Content-Type", video.mimeType);
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Length", video.sizeBytes.toString());
    try {
      await pipeline(object.Body, response);
    } finally {
      object.Body.destroy();
    }
  }

  @Patch(":id")
  @ApiParam({ name: "id", format: "uuid" })
  @documentedBody(renameBody)
  @ApiOperation({ summary: "Rename an owned video" })
  async rename(
    @Req() request: AuthenticatedRequest,
    @Param("id") idParam: string,
    @Body() body: unknown,
  ) {
    const id = validate(uuid, idParam);
    const { title: newTitle } = validate(renameBody, body);
    return this.db.$transaction(async (tx) => {
      const updated = await tx.video.updateMany({
        where: { id, userId: request.auth.user.id, ...visible },
        data: { title: newTitle },
      });
      if (!updated.count) throw new NotFoundException("Video not found");
      const video = await tx.video.findUniqueOrThrow({
        where: { id },
        include: shareState,
      });
      return this.presenter.video(video, null, video.shares.length > 0);
    });
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({
    summary:
      "Revoke access and schedule deletion of the original and derived files",
  })
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param("id") idParam: string,
  ) {
    const id = validate(uuid, idParam);
    const userId = request.auth.user.id;
    const video = await this.db.video.findFirst({
      where: { id, userId },
      select: { status: true, upload: { select: { id: true } } },
    });
    if (!video) throw new NotFoundException("Video not found");
    if (video.status === "DELETING" || video.status === "DELETED") return;
    if (video.status === "UPLOADING" && video.upload) {
      await this.uploads.cancel(userId, video.upload.id);
      return;
    }

    await this.db.$transaction(async (tx) => {
      const now = new Date();
      // Publication and deletion take the same lock order, fencing a running encoder before cleanup.
      await tx.$queryRaw`SELECT id FROM "ProcessingJob" WHERE "videoId" = ${id} FOR UPDATE`;
      const job = await tx.processingJob.findUnique({
        where: { videoId: id },
        select: { leaseExpiresAt: true },
      });
      const claimed = await tx.video.updateMany({
        where: {
          id,
          userId,
          status: { in: ["PROCESSING", "READY", "FAILED"] },
        },
        data: { status: "DELETING", deletedAt: now },
      });
      if (!claimed.count) return;
      await tx.processingJob.updateMany({
        where: { videoId: id, status: { in: ["PENDING", "RUNNING"] } },
        data: { status: "CANCELLED", leaseToken: null, leaseExpiresAt: null },
      });
      await tx.shareToken.updateMany({
        where: { videoId: id, revokedAt: null },
        data: { revokedAt: now },
      });
      const availableAt = new Date(
        Math.max(now.getTime(), (job?.leaseExpiresAt?.getTime() ?? 0) + 30_000),
      );
      await tx.outbox.create({
        data: { kind: "CLEANUP_VIDEO", videoId: id, payload: {}, availableAt },
      });
    });
  }

  @Post(":id/share")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({
    summary: "Rotate the unlisted share link for an owned, ready video",
  })
  async share(
    @Req() request: AuthenticatedRequest,
    @Param("id") idParam: string,
  ) {
    const id = validate(uuid, idParam);
    const userId = request.auth.user.id;
    if (DEMO_MODE)
      throw new ConflictException(
        "Public sharing is disabled in free demo mode",
      );
    const token = newSecret();
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Video" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;
      const video = await tx.video.findFirst({
        where: { id, userId, ...visible },
        select: { status: true },
      });
      if (!video) throw new NotFoundException("Video not found");
      if (video.status !== "READY")
        throw new ConflictException("This video is not ready to share");
      await tx.shareToken.deleteMany({ where: { videoId: id } });
      await tx.shareToken.create({
        data: { videoId: id, tokenHash: digest(token) },
      });
    });
    return { token };
  }

  @Delete(":id/share")
  @HttpCode(204)
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Revoke the active unlisted share link" })
  async revoke(
    @Req() request: AuthenticatedRequest,
    @Param("id") idParam: string,
  ) {
    const id = validate(uuid, idParam);
    const userId = request.auth.user.id;
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Video" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;
      const video = await tx.video.findFirst({
        where: { id, userId, ...visible },
        select: { id: true },
      });
      if (!video) throw new NotFoundException("Video not found");
      await tx.shareToken.updateMany({
        where: { videoId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }
}

@ApiTags("Sharing")
@Controller("share")
export class ShareController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(VideoPresenter) private readonly presenter: VideoPresenter,
  ) {}

  @Get(":token")
  @ApiParam({
    name: "token",
    type: String,
    description: "The revocable link token",
  })
  @ApiOperation({
    summary:
      "Resolve a live share link to a ready video and obtain playback authorization",
  })
  async get(@Param("token") tokenParam: string) {
    const token = validate(opaqueSecret, tokenParam);
    const share = await this.db.shareToken.findFirst({
      where: {
        tokenHash: digest(token),
        revokedAt: null,
        video: { status: "READY" },
      },
      include: { video: true },
    });
    if (!share)
      throw new NotFoundException("This share link is no longer available");
    return this.presenter.video(share.video, share.id, true);
  }
}
