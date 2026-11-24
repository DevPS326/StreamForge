import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  GoneException,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import {
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { Prisma } from "@streamforge/db";
import { z } from "zod";
import { SessionGuard, type AuthenticatedRequest } from "./auth";
import { API_CONFIG, type ApiConfig } from "./config";
import { Database } from "./database";
import { VideoPresenter } from "./media";
import { Storage, storageStatus, type StoredPart } from "./storage";
import { documentedBody, title, uuid, validate } from "./validation";

const MIB = 1024 ** 2;
const MAX_PARTS = 10_000;
const INITIATION_STALE_MS = 2 * 60_000;
const COMPLETION_STALE_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const uploadInclude = { video: true } as const;
type Upload = Prisma.UploadSessionGetPayload<{ include: typeof uploadInclude }>;

const createBody = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((name) => !/[\\/\p{Cc}]/u.test(name), "Enter a valid filename"),
  mimeType: z.string().trim().toLowerCase().max(100),
  size: z.number().int().positive(),
  title: title.optional(),
  requestKey: uuid.optional(),
});
const partBody = z.object({
  partNumbers: z.array(z.number().int().min(1).max(MAX_PARTS)).min(1).max(32),
});

const mimeTypes: Readonly<
  Record<string, { canonical: string; accepted: string[] }>
> = {
  mp4: { canonical: "video/mp4", accepted: ["video/mp4"] },
  m4v: { canonical: "video/mp4", accepted: ["video/mp4", "video/x-m4v"] },
  mov: {
    canonical: "video/quicktime",
    accepted: ["video/quicktime", "video/mp4"],
  },
  webm: { canonical: "video/webm", accepted: ["video/webm"] },
  mkv: {
    canonical: "video/x-matroska",
    accepted: ["video/x-matroska", "video/matroska"],
  },
  avi: {
    canonical: "video/x-msvideo",
    accepted: ["video/x-msvideo", "video/avi", "video/msvideo"],
  },
};

export function validatedMime(filename: string, mimeType: string) {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const family = Object.hasOwn(mimeTypes, extension)
    ? mimeTypes[extension]
    : undefined;
  const generic = mimeType === "" || mimeType === "application/octet-stream";
  if (
    !filename.includes(".") ||
    !family ||
    (!generic && !family.accepted.includes(mimeType))
  ) {
    throw new BadRequestException(
      "Choose an MP4, MOV, WebM, MKV, or AVI video",
    );
  }
  return family.canonical;
}

export function multipartLayout(size: number) {
  const partSize = Math.max(8, Math.ceil(size / MAX_PARTS / MIB)) * MIB;
  return { partSize, partCount: Math.ceil(size / partSize) };
}

export function expectedPartBytes(
  size: number,
  partSize: number,
  partNumber: number,
) {
  return Math.min(partSize, size - (partNumber - 1) * partSize);
}

export function completeParts(
  parts: StoredPart[],
  size: number,
  partSize: number,
  partCount: number,
) {
  return (
    parts.length === partCount &&
    parts.every(
      ({ partNumber, etag, size: stored }, index) =>
        partNumber === index + 1 &&
        Boolean(etag) &&
        stored === expectedPartBytes(size, partSize, partNumber),
    )
  );
}

function uploadResponse(session: Upload, parts: StoredPart[] = []) {
  return {
    id: session.id,
    videoId: session.videoId,
    title: session.video.title,
    filename: session.filename,
    size: Number(session.video.sizeBytes),
    mimeType: session.video.mimeType,
    partSize: session.partSize,
    partCount: session.partCount,
    requestKey: session.requestKey?.split(":").at(-1) ?? null,
    expiresAt: session.expiresAt,
    status: session.status,
    parts,
  };
}

type CreateUpload = z.infer<typeof createBody>;

@Injectable()
export class Uploads {
  private readonly log = new Logger(Uploads.name);

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Storage) private readonly storage: Storage,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private async find(userId: string, id: string) {
    const upload = await this.db.uploadSession.findFirst({
      where: { id, video: { userId } },
      include: uploadInclude,
    });
    if (!upload) throw new NotFoundException("Upload session not found");
    return upload;
  }

  async list(userId: string) {
    const uploads = await this.db.uploadSession.findMany({
      where: {
        video: { userId, status: "UPLOADING" },
        status: { in: ["INITIATING", "ACTIVE", "COMPLETING"] },
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      take: this.config.MAX_ACTIVE_UPLOADS,
      include: uploadInclude,
    });
    return { items: uploads.map((upload) => uploadResponse(upload)) };
  }

  async create(userId: string, input: CreateUpload) {
    if (input.size > this.config.MAX_UPLOAD_BYTES) {
      throw new BadRequestException(
        `The file exceeds the ${Math.floor(this.config.MAX_UPLOAD_BYTES / MIB)} MiB upload limit`,
      );
    }
    const mimeType = validatedMime(input.filename, input.mimeType);
    const requestKey = input.requestKey && `${userId}:${input.requestKey}`;
    const reservation = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const existing =
        requestKey &&
        (await tx.uploadSession.findUnique({
          where: { requestKey },
          include: uploadInclude,
        }));
      if (existing) {
        if (
          existing.filename !== input.filename ||
          existing.video.sizeBytes !== BigInt(input.size) ||
          existing.video.mimeType !== mimeType
        ) {
          throw new ConflictException(
            "This request key was already used for a different file",
          );
        }
        return { upload: existing, fresh: false };
      }
      const [total, active] = await Promise.all([
        tx.video.aggregate({
          where: { userId, status: { not: "DELETED" } },
          _sum: { sizeBytes: true },
        }),
        tx.video.count({ where: { userId, status: "UPLOADING" } }),
      ]);
      if (
        (total._sum.sizeBytes ?? 0n) + BigInt(input.size) >
        BigInt(this.config.USER_QUOTA_BYTES)
      ) {
        throw new ConflictException(
          "Your storage quota is full. Delete a video before uploading again",
        );
      }
      if (active >= this.config.MAX_ACTIVE_UPLOADS)
        throw new ConflictException("Too many uploads in progress");

      const videoId = randomUUID();
      const upload = await tx.uploadSession.create({
        include: uploadInclude,
        data: {
          status: "INITIATING",
          requestKey,
          filename: input.filename,
          ...multipartLayout(input.size),
          expiresAt: new Date(
            Date.now() + this.config.UPLOAD_EXPIRY_HOURS * HOUR_MS,
          ),
          video: {
            create: {
              id: videoId,
              userId,
              title:
                input.title ??
                (input.filename
                  .replace(/\.[^.]+$/, "")
                  .trim()
                  .slice(0, 160) ||
                  "Untitled video"),
              originalKey: `originals/${videoId}/source`,
              status: "UPLOADING",
              sizeBytes: BigInt(input.size),
              mimeType,
            },
          },
        },
      });
      return { upload, fresh: true };
    });
    return uploadResponse(
      await this.initiate(reservation.upload, reservation.fresh),
    );
  }

  private async initiate(upload: Upload, fresh = false) {
    if (upload.status !== "INITIATING") return upload;
    if (upload.expiresAt <= new Date())
      throw new GoneException("This upload has expired");
    let claim = upload.updatedAt;
    if (!fresh) {
      claim = new Date();
      const updated = await this.db.uploadSession.updateMany({
        where: {
          id: upload.id,
          status: "INITIATING",
          updatedAt: { lte: new Date(claim.getTime() - INITIATION_STALE_MS) },
        },
        data: { updatedAt: claim },
      });
      if (!updated.count)
        throw new ConflictException(
          "The upload is being prepared. Try again shortly",
        );
    }

    const { originalKey, mimeType } = upload.video;
    let uploadId: string;
    try {
      uploadId = await this.storage.begin(originalKey, mimeType, upload.id);
    } catch (error) {
      // A lost response may leave an unknown multipart ID that the bucket lifecycle will expire.
      await this.db.uploadSession.updateMany({
        where: { id: upload.id, status: "INITIATING", updatedAt: claim },
        data: { updatedAt: new Date(0) },
      });
      this.log.warn({
        event: "multipart_init_failed",
        uploadId: upload.id,
        error: error instanceof Error ? error.name : "Unknown",
      });
      throw new ServiceUnavailableException(
        "Storage could not prepare the upload. Try again",
      );
    }
    const saved = await this.db.uploadSession.updateMany({
      where: { id: upload.id, status: "INITIATING", updatedAt: claim },
      data: { status: "ACTIVE", storageUploadId: uploadId },
    });
    if (!saved.count) {
      await this.storage.abort(originalKey, uploadId).catch(() => {
        this.log.warn({
          event: "multipart_unclaimed_abort_failed",
          uploadId: upload.id,
        });
      });
      throw new ConflictException(
        "This upload changed while it was being prepared",
      );
    }
    return this.find(upload.video.userId, upload.id);
  }

  async inspect(userId: string, id: string) {
    const upload = await this.initiate(await this.find(userId, id));
    if (upload.status !== "ACTIVE" || !upload.storageUploadId)
      return uploadResponse(upload);
    if (upload.expiresAt <= new Date())
      throw new GoneException("This upload has expired");
    try {
      const parts = await this.storage.parts(
        upload.video.originalKey,
        upload.storageUploadId,
      );
      const valid = parts.filter(
        (part) =>
          part.partNumber >= 1 &&
          part.partNumber <= upload.partCount &&
          part.size ===
            expectedPartBytes(
              Number(upload.video.sizeBytes),
              upload.partSize,
              part.partNumber,
            ),
      );
      return uploadResponse(upload, valid);
    } catch (error) {
      if (storageStatus(error, "NoSuchUpload", 404)) {
        const current = await this.find(userId, id);
        if (current.status !== "ACTIVE") return uploadResponse(current);
        throw new GoneException("This upload is no longer available");
      }
      throw new ServiceUnavailableException(
        "Storage could not recover the uploaded parts. Try again",
      );
    }
  }

  async sign(userId: string, id: string, partNumbers: number[]) {
    const upload = await this.find(userId, id);
    if (upload.status !== "ACTIVE" || !upload.storageUploadId)
      throw new ConflictException("This upload is not accepting parts");
    if (upload.expiresAt <= new Date())
      throw new GoneException("This upload has expired");
    const distinct = [...new Set(partNumbers)];
    if (distinct.some((partNumber) => partNumber > upload.partCount))
      throw new BadRequestException("Part number exceeds the upload layout");
    const { storageUploadId, partSize, video } = upload;
    const urls = await Promise.all(
      distinct.map(async (partNumber) => ({
        partNumber,
        url: await this.storage.signPart(
          video.originalKey,
          storageUploadId,
          partNumber,
          expectedPartBytes(Number(video.sizeBytes), partSize, partNumber),
        ),
      })),
    );
    return { urls };
  }

  async complete(userId: string, id: string) {
    const upload = await this.find(userId, id);
    if (upload.status === "COMPLETED") return upload.video;
    if (
      !upload.storageUploadId ||
      !["ACTIVE", "COMPLETING"].includes(upload.status)
    ) {
      throw new ConflictException("This upload cannot be completed");
    }
    if (upload.status === "ACTIVE" && upload.expiresAt <= new Date())
      throw new GoneException("This upload has expired");
    const now = new Date();
    if (
      upload.status === "COMPLETING" &&
      upload.updatedAt.getTime() > now.getTime() - COMPLETION_STALE_MS
    ) {
      const existing = await this.head(upload);
      if (existing) return this.publish(upload, upload.updatedAt, existing);
      throw new ConflictException(
        "This upload is being verified. Try again shortly",
      );
    }
    const claimed = await this.db.uploadSession.updateMany({
      where: { id, status: upload.status, updatedAt: upload.updatedAt },
      data: { status: "COMPLETING", updatedAt: now },
    });
    if (!claimed.count) {
      const current = await this.find(userId, id);
      if (current.status === "COMPLETED") return current.video;
      throw new ConflictException("This upload changed. Try again shortly");
    }

    let object =
      upload.status === "COMPLETING" ? await this.head(upload) : undefined;
    if (!object) {
      let parts: StoredPart[];
      try {
        parts = await this.storage.parts(
          upload.video.originalKey,
          upload.storageUploadId,
        );
      } catch (error) {
        if (!storageStatus(error, "NoSuchUpload", 404)) {
          throw new ServiceUnavailableException(
            "Storage could not verify the uploaded parts. Try again",
          );
        }
        object = await this.head(upload);
        if (object) return this.publish(upload, now, object);
        await this.abort(upload, "COMPLETING", now, true);
        throw new GoneException(
          "This upload is no longer available. Start a new upload",
        );
      }
      if (
        !completeParts(
          parts,
          Number(upload.video.sizeBytes),
          upload.partSize,
          upload.partCount,
        )
      ) {
        await this.db.uploadSession.updateMany({
          where: { id, status: "COMPLETING", updatedAt: now },
          data: { status: "ACTIVE" },
        });
        throw new ConflictException(
          "Some upload parts are missing or incomplete",
        );
      }
      try {
        await this.storage.complete(
          upload.video.originalKey,
          upload.storageUploadId,
          parts,
        );
      } catch (error) {
        object = await this.head(upload);
        if (object) return this.publish(upload, now, object);
        if (storageStatus(error, "InvalidPart", 400)) {
          await this.db.uploadSession.updateMany({
            where: { id, status: "COMPLETING", updatedAt: now },
            data: { status: "ACTIVE" },
          });
          throw new ConflictException(
            "The uploaded parts changed. Resume the upload and try again",
          );
        }
        throw new ServiceUnavailableException(
          "Storage has not confirmed completion. Try again shortly",
        );
      }
      object = await this.head(upload);
    }
    if (!object)
      throw new ServiceUnavailableException(
        "Storage is still verifying the completed object",
      );
    return this.publish(upload, now, object);
  }

  private async head(upload: Upload) {
    try {
      return await this.storage.head(upload.video.originalKey);
    } catch {
      throw new ServiceUnavailableException(
        "Storage could not verify the completed object. Try again",
      );
    }
  }

  private async publish(
    upload: Upload,
    claim: Date,
    object: NonNullable<Awaited<ReturnType<Storage["head"]>>>,
  ) {
    const { id, videoId } = upload;
    if (
      object.ContentLength !== Number(upload.video.sizeBytes) ||
      object.ContentType !== upload.video.mimeType ||
      object.Metadata?.["upload-session"] !== id
    ) {
      await this.abort(upload, "COMPLETING", claim, true);
      throw new BadRequestException(
        "The completed file did not match this upload",
      );
    }
    return this.db.$transaction(async (tx) => {
      const committed = await tx.uploadSession.updateMany({
        where: { id, status: "COMPLETING", updatedAt: claim },
        data: { status: "COMPLETED" },
      });
      if (!committed.count) {
        const current = await tx.uploadSession.findUniqueOrThrow({
          where: { id },
          include: uploadInclude,
        });
        if (current.status === "COMPLETED") return current.video;
        throw new ConflictException(
          "This upload changed while it was being verified",
        );
      }
      const updated = await tx.video.updateMany({
        where: { id: videoId, status: "UPLOADING" },
        data: { status: "PROCESSING" },
      });
      if (!updated.count)
        throw new ConflictException(
          "This video is no longer accepting uploads",
        );
      const job = await tx.processingJob.create({
        data: { videoId, status: "PENDING" },
      });
      await tx.outbox.create({
        data: {
          kind: "PROCESS_VIDEO",
          videoId,
          payload: { jobId: job.id, videoId },
        },
      });
      return tx.video.findUniqueOrThrow({ where: { id: videoId } });
    });
  }

  private abort(
    upload: Upload,
    status: Upload["status"],
    updatedAt?: Date,
    failed = false,
  ) {
    return this.db.$transaction(async (tx) => {
      const claimed = await tx.uploadSession.updateMany({
        where: { id: upload.id, status, updatedAt },
        data: { status: "ABORTING" },
      });
      if (!claimed.count) return false;
      const updated = await tx.video.updateMany({
        where: { id: upload.videoId, status: "UPLOADING" },
        data: failed
          ? { status: "FAILED", failureCode: "UPLOAD_INVALID" }
          : { status: "DELETING", deletedAt: new Date() },
      });
      if (!updated.count)
        throw new ConflictException("This upload has changed");
      await tx.outbox.create({
        data: { kind: "CLEANUP_VIDEO", videoId: upload.videoId, payload: {} },
      });
      return true;
    });
  }

  async cancel(userId: string, id: string) {
    const upload = await this.find(userId, id);
    if (upload.status === "ABORTED" || upload.status === "ABORTING") return;
    if (
      !["ACTIVE", "INITIATING"].includes(upload.status) ||
      !(await this.abort(upload, upload.status))
    ) {
      throw new ConflictException(
        "This upload is being verified or already completed",
      );
    }
  }

  async reconcile() {
    const now = new Date();
    const expired = await this.db.uploadSession.findMany({
      where: {
        expiresAt: { lte: now },
        status: { in: ["ACTIVE", "INITIATING"] },
      },
      orderBy: { expiresAt: "asc" },
      take: 20,
      include: uploadInclude,
    });
    for (const upload of expired) {
      await this.abort(upload, upload.status).catch(() => {
        this.log.warn({
          event: "expired_upload_abort_failed",
          uploadId: upload.id,
        });
      });
    }

    const stranded = await this.db.uploadSession.findMany({
      where: {
        status: "COMPLETING",
        updatedAt: { lte: new Date(now.getTime() - COMPLETION_STALE_MS) },
      },
      orderBy: { updatedAt: "asc" },
      take: 10,
      include: uploadInclude,
    });
    for (const upload of stranded) {
      try {
        await this.complete(upload.video.userId, upload.id);
      } catch (error) {
        this.log.warn({
          event: "upload_reconciliation_failed",
          uploadId: upload.id,
          error: error instanceof Error ? error.name : "Unknown",
        });
      }
    }
  }
}

@ApiTags("Uploads")
@ApiCookieAuth("sf_session")
@UseGuards(SessionGuard)
@Controller("uploads")
export class UploadController {
  constructor(
    @Inject(Uploads) private readonly uploads: Uploads,
    @Inject(VideoPresenter) private readonly presenter: VideoPresenter,
  ) {}

  @Get()
  @ApiOperation({ summary: "List resumable uploads for the signed-in account" })
  list(@Req() request: AuthenticatedRequest) {
    return this.uploads.list(request.auth.user.id);
  }

  @Post()
  @documentedBody(createBody)
  @ApiOperation({
    summary: "Reserve quota and initiate a verified S3 multipart upload",
  })
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.uploads.create(
      request.auth.user.id,
      validate(createBody, body),
    );
  }

  @Get(":id")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({
    summary:
      "Recover canonical multipart session state and uploaded parts from storage",
  })
  inspect(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    return this.uploads.inspect(request.auth.user.id, validate(uuid, id));
  }

  @Post(":id/parts")
  @HttpCode(200)
  @ApiParam({ name: "id", format: "uuid" })
  @documentedBody(partBody)
  @ApiOperation({ summary: "Presign up to 32 size-bound part uploads" })
  parts(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.uploads.sign(
      request.auth.user.id,
      validate(uuid, id),
      validate(partBody, body).partNumbers,
    );
  }

  @Post(":id/complete")
  @HttpCode(200)
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({
    summary:
      "Verify and finalize multipart upload and persist its processing job",
  })
  async complete(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    const video = await this.uploads.complete(
      request.auth.user.id,
      validate(uuid, id),
    );
    return this.presenter.video(video);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({
    summary: "Cancel an active upload and schedule storage cleanup",
  })
  async cancel(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    await this.uploads.cancel(request.auth.user.id, validate(uuid, id));
  }
}
