import { createHmac, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Video } from "@streamforge/db";
import type { Request, Response } from "express";
import { z } from "zod";
import { API_CONFIG, API_PREFIX, type ApiConfig } from "./config";
import { Database } from "./database";
import { DemoGate, DEMO_MODE } from "./demo";
import { Storage, storageStatus } from "./storage";
import { uuid, validate } from "./validation";

const MANIFEST_MAX_BYTES = 1024 * 1024;
const assetComponent = /^[A-Za-z0-9_.-]{1,120}$/;
const assetExtension = /\.(?:m3u8|ts|m4s|mp4|jpg|jpeg|webp)$/;
const grantSchema = z.object({
  id: uuid,
  prefix: z.string().max(150),
  shareId: uuid.nullable(),
  expiresAt: z.number().int(),
});
type Grant = z.infer<typeof grantSchema>;

function mac(body: string, secret: string) {
  return createHmac("sha256", secret).update(body).digest();
}

export function signGrant(grant: Grant, secret: string) {
  const body = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${body}.${mac(body, secret).toString("base64url")}`;
}

export function verifyGrant(
  token: string,
  secret: string,
  now = Date.now(),
): Grant | undefined {
  if (!/^[A-Za-z0-9_-]{1,600}\.[A-Za-z0-9_-]{43}$/.test(token))
    return undefined;
  const [body, signature] = token.split(".");
  const observed = Buffer.from(signature, "base64url");
  if (!timingSafeEqual(observed, mac(body, secret))) return undefined;
  try {
    const parsed = grantSchema.safeParse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    );
    if (parsed.success && parsed.data.expiresAt > now) return parsed.data;
  } catch {
    return undefined;
  }
  return undefined;
}

export function validAssetPath(path: string) {
  return (
    path.length <= 255 &&
    assetExtension.test(path) &&
    path
      .split("/")
      .every(
        (component) =>
          assetComponent.test(component) &&
          component !== "." &&
          component !== "..",
      )
  );
}

export function rewritePlaylist(
  text: string,
  path: string,
  toUrl: (path: string) => string,
) {
  if (!text.startsWith("#EXTM3U")) throw new Error("Invalid HLS playlist");
  const rewrite = (relative: string) => {
    if (!validAssetPath(relative)) throw new Error("Invalid media reference");
    return toUrl(posix.join(posix.dirname(path), relative));
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#"))
        return trimmed.replace(
          /\bURI="([^"]+)"/g,
          (_match, relative: string) => `URI="${rewrite(relative)}"`,
        );
      return rewrite(trimmed);
    })
    .join("\n");
}

function mediaUrl(config: ApiConfig, id: string, path: string, token: string) {
  const segments = path.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`/${API_PREFIX}/media/${id}/${segments}`, config.apiUrl);
  url.searchParams.set("grant", token);
  return url.toString();
}

@Injectable()
export class VideoPresenter {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  video(video: Video, shareId: string | null = null, shared = false) {
    let playbackUrl: string | null = null;
    let thumbnailUrl: string | null = null;
    if (video.status === "READY" && video.mediaPrefix) {
      const token = signGrant(
        {
          id: video.id,
          shareId,
          prefix: video.mediaPrefix,
          expiresAt: Date.now() + Math.min(120, this.config.MEDIA_TOKEN_TTL_SECONDS) * 1000,
        },
        this.config.MEDIA_TOKEN_SECRET,
      );
      playbackUrl = mediaUrl(this.config, video.id, "master.m3u8", token);
      thumbnailUrl = mediaUrl(this.config, video.id, "poster.jpg", token);
    }
    return {
      id: video.id,
      title: video.title,
      status: video.status,
      size: Number(video.sizeBytes),
      mimeType: video.mimeType,
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
      duration: video.durationSeconds,
      width: video.width,
      height: video.height,
      shared,
      playbackUrl,
      thumbnailUrl,
    };
  }
}

@ApiTags("Media")
@Controller("media")
export class MediaController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(DemoGate) private readonly gate: DemoGate,
    @Inject(Storage) private readonly storage: Storage,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private cloudfrontUrl(key: string, expiresAt: number): string {
    const { CLOUDFRONT_URL, CLOUDFRONT_KEY_PAIR_ID, CLOUDFRONT_PRIVATE_KEY } =
      this.config;
    if (!CLOUDFRONT_URL || !CLOUDFRONT_KEY_PAIR_ID || !CLOUDFRONT_PRIVATE_KEY)
      throw new Error("CloudFront is not configured");
    return getSignedUrl({
      url: new URL(
        "/" + key.split("/").map(encodeURIComponent).join("/"),
        CLOUDFRONT_URL,
      ).toString(),
      keyPairId: CLOUDFRONT_KEY_PAIR_ID,
      privateKey: CLOUDFRONT_PRIVATE_KEY.replace(/\\n/g, "\n"),
      dateLessThan: new Date(expiresAt).toISOString(),
    });
  }

  @Get(":id/*asset")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiParam({
    name: "asset",
    type: String,
    description: "Relative path under the authorized rendition prefix",
  })
  @ApiQuery({ name: "grant", type: String, required: true })
  @ApiOperation({
    summary: "Serve authorized HLS playlists, segments, and posters",
  })
  async get(
    @Param("id") idParam: string,
    @Param("asset") asset: string | string[],
    @Query("grant") grantParam: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const id = validate(uuid, idParam);
    const path = Array.isArray(asset) ? asset.join("/") : (asset ?? "");
    const grant =
      typeof grantParam === "string"
        ? verifyGrant(grantParam, this.config.MEDIA_TOKEN_SECRET)
        : undefined;
    if (DEMO_MODE && grant?.shareId)
      throw new NotFoundException("Public sharing is disabled in free demo mode");
    if (!grant || grant.id !== id || !validAssetPath(path))
      throw new NotFoundException("Media is not available");

    const video = await this.db.video.findFirst({
      where: {
        id,
        status: "READY",
        mediaPrefix: grant.prefix,
        ...(grant.shareId
          ? { shares: { some: { id: grant.shareId, revokedAt: null } } }
          : {}),
      },
      select: { id: true, userId: true },
    });
    if (!video) throw new NotFoundException("Media is not available");
    if (DEMO_MODE) await this.gate.assertActive(video.userId);

    response.setHeader("Cache-Control", "private, no-store");
    const key = `${grant.prefix}/${path}`;
    const isManifest = path.endsWith(".m3u8");
    if (this.config.CLOUDFRONT_URL && !isManifest) {
      response.redirect(302, this.cloudfrontUrl(key, grant.expiresAt));
      return;
    }
    const range = isManifest ? undefined : request.headers.range;
    if (range && !/^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/.test(range))
      throw new BadRequestException("Invalid byte range");

    const cancellation = new AbortController();
    const disconnect = () => {
      if (!response.writableEnded) cancellation.abort();
    };
    response.once("close", disconnect);
    try {
      const object = await this.storage.get(key, range, cancellation.signal);
      if (!(object.Body instanceof Readable))
        throw new Error("Storage returned an invalid media response");

      if (isManifest) {
        if (
          !object.ContentLength ||
          object.ContentLength > MANIFEST_MAX_BYTES
        ) {
          object.Body.destroy();
          throw new Error("Invalid manifest size");
        }
        const m3u8 = await object.Body.transformToString();
        const manifest = rewritePlaylist(m3u8, path, (child) => {
          if (this.config.CLOUDFRONT_URL && !child.endsWith(".m3u8")) {
            return this.cloudfrontUrl(
              `${grant.prefix}/${child}`,
              grant.expiresAt,
            );
          }
          return mediaUrl(this.config, id, child, grantParam as string);
        });
        response.type("application/vnd.apple.mpegurl").send(manifest);
        return;
      }

      if (object.ContentRange) {
        response.status(206).setHeader("Content-Range", object.ContentRange);
      }
      response.setHeader(
        "Content-Type",
        object.ContentType ?? "application/octet-stream",
      );
      response.setHeader("Accept-Ranges", "bytes");
      if (object.ContentLength !== undefined)
        response.setHeader("Content-Length", object.ContentLength);
      await pipeline(object.Body, response);
    } catch (error) {
      if (cancellation.signal.aborted || response.headersSent) return;
      if (storageStatus(error, "NoSuchKey", 404))
        throw new NotFoundException("Media is not available");
      if (storageStatus(error, "InvalidRange", 416))
        throw new HttpException("The requested range is not available", 416);
      throw new ServiceUnavailableException(
        "Media could not be loaded. Try again",
      );
    } finally {
      response.off("close", disconnect);
    }
  }
}
