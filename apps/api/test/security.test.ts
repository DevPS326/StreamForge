import "reflect-metadata";
import type { ArgumentsHost } from "@nestjs/common";
import { Prisma } from "@streamforge/db";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { hashPassword, newSecret, passwordMatches } from "../src/auth";
import { parseConfig } from "../src/config";
import type { Database } from "../src/database";
import type { DemoGate } from "../src/demo";
import { ApiErrors, httpPolicy } from "../src/http";
import {
  MediaController,
  rewritePlaylist,
  signGrant,
  validAssetPath,
  verifyGrant,
} from "../src/media";
import { Storage } from "../src/storage";
import { afterCursor } from "../src/videos";

const secret = "api-test-secret-not-valid-for-use-in-production";
const config = parseConfig({
  DATABASE_URL: "postgresql://localhost/test",
  MEDIA_TOKEN_SECRET: secret,
  AWS_ACCESS_KEY_ID: "local",
  AWS_SECRET_ACCESS_KEY: "local-local",
  S3_BUCKET: "streamforge",
  S3_ENDPOINT: "http://storage:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  SQS_QUEUE_URL: "http://localhost:9324/queue/test",
});

it("returns a safe 503 when Prisma cannot initialize a database connection", () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const response = { status, locals: { requestId: "test-request" } };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: "POST" }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  new ApiErrors().catch(
    new Prisma.PrismaClientInitializationError(
      "internal connection details",
      "test",
    ),
    host,
  );

  expect(status).toHaveBeenCalledWith(503);
  expect(json).toHaveBeenCalledWith({
    statusCode: 503,
    message: "StreamForge is temporarily unavailable. Try again in a moment.",
    requestId: "test-request",
  });
});

describe("password storage", () => {
  it("uses independent salts, rejects the wrong password, and generates opaque 256-bit credentials", async () => {
    const hashes = await Promise.all([
      hashPassword("password with unicode 澜"),
      hashPassword("password with unicode 澜"),
    ]);
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(hashes[0]).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    await expect(
      passwordMatches("password with unicode 澜", hashes[0]),
    ).resolves.toBe(true);
    await expect(
      passwordMatches("password with unicode 岚", hashes[0]),
    ).resolves.toBe(false);
    await expect(
      passwordMatches("password with unicode 澜", "invalid encoded key"),
    ).resolves.toBe(false);
    expect(newSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("private media access", () => {
  const id = randomUUID();
  const shareId = randomUUID();
  const grant = {
    id,
    shareId,
    prefix: `media/${id}/${randomUUID()}`,
    expiresAt: 1_000_000,
  };

  it("verifies integrity, expiration, and signing key", () => {
    const signed = signGrant(grant, secret);
    expect(verifyGrant(signed, secret, grant.expiresAt - 1)).toEqual(grant);
    expect(verifyGrant(signed, secret, grant.expiresAt)).toBeUndefined();
    expect(verifyGrant(signed, "different key", 0)).toBeUndefined();
    const modifiedBody = Buffer.from(
      JSON.stringify({ ...grant, id: randomUUID() }),
    ).toString("base64url");
    expect(
      verifyGrant(`${modifiedBody}.${signed.split(".")[1]}`, secret, 0),
    ).toBeUndefined();
  });

  it("denies a revoked share even if the playlist grant has a valid signature", async () => {
    const token = signGrant(
      { ...grant, expiresAt: Date.now() + 10_000 },
      secret,
    );
    const findFirst = vi.fn().mockResolvedValue(null);
    const get = vi.fn();
    const controller = new MediaController(
      { video: { findFirst } } as unknown as Database,
      {} as DemoGate,
      { get } as unknown as Storage,
      config,
    );
    await expect(
      controller.get(id, ["master.m3u8"], token, {} as Request, {} as Response),
    ).rejects.toMatchObject({ status: 404 });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id,
          status: "READY",
          mediaPrefix: grant.prefix,
          shares: { some: { id: shareId, revokedAt: null } },
        },
      }),
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("denies requests with no scope or a scope for a different video before querying storage", async () => {
    const token = signGrant(
      { ...grant, expiresAt: Date.now() + 10_000 },
      secret,
    );
    const findFirst = vi.fn();
    const controller = new MediaController(
      { video: { findFirst } } as unknown as Database,
      {} as DemoGate,
      {} as Storage,
      config,
    );
    await expect(
      controller.get(
        randomUUID(),
        "master.m3u8",
        token,
        {} as Request,
        {} as Response,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      controller.get(
        id,
        "master.m3u8",
        undefined,
        {} as Request,
        {} as Response,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("rewrites variant, segment and initialization URIs within the authorized root", () => {
    const variant = rewritePlaylist(
      '#EXTM3U\r\n#EXT-X-MAP:URI="init.mp4"\r\n#EXTINF:4.0,\r\nsegment-000001.m4s\r\n',
      "v0/index.m3u8",
      (file) => `http://localhost/media/${file}?grant=token`,
    );
    expect(variant).toContain(
      'URI="http://localhost/media/v0/init.mp4?grant=token"',
    );
    expect(variant).toContain(
      "http://localhost/media/v0/segment-000001.m4s?grant=token",
    );
    expect(
      rewritePlaylist(
        "#EXTM3U\nv0/index.m3u8\n",
        "master.m3u8",
        (file) => file,
      ),
    ).toBe("#EXTM3U\nv0/index.m3u8\n");
  });

  it.each([
    "../private.ts",
    "/other.ts",
    "https://other.example.com/a.ts",
    "v0/%2fother.ts",
    "v0\\other.ts",
    "v0/segment.ts?grant=bad",
  ])("rejects unsafe media path %s", (path) => {
    expect(validAssetPath(path)).toBe(false);
    expect(() =>
      rewritePlaylist(`#EXTM3U\n${path}\n`, "master.m3u8", (file) => file),
    ).toThrow("Invalid media reference");
  });
});

describe("HTTP policy", () => {
  function response() {
    return {
      locals: {},
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
  }

  it("checks mutation origins, generates correlation IDs, and permits a configured origin", () => {
    const policy = httpPolicy(config);
    const next = vi.fn();
    const foreign = response();
    const request = {
      method: "PATCH",
      path: "/api/v1/auth/me",
      get: (header: string) =>
        header === "origin" ? "https://foreign.example.com" : "id with spaces",
    };
    policy(request as Request, foreign as unknown as Response, next);
    expect(foreign.status).toHaveBeenCalledWith(403);
    expect(foreign.setHeader).toHaveBeenCalledWith(
      "X-Request-ID",
      expect.stringMatching(/^[a-f0-9-]{36}$/),
    );
    expect(next).not.toHaveBeenCalled();
    policy(
      {
        ...request,
        get: (header) =>
          header === "origin" ? "http://localhost:3000" : "trace_1",
        ip: "127.0.0.1",
      } as Request,
      response() as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("rate-limits authentication attempts even when path case or trailing slash differs", () => {
    const policy = httpPolicy(config);
    const next = vi.fn();
    const current = response();
    const request = { method: "POST", ip: "127.0.0.1", get: () => undefined };
    for (let count = 0; count < 12; count++) {
      policy(
        { ...request, path: "/api/v1/auth/register" } as unknown as Request,
        current as unknown as Response,
        next,
      );
    }
    policy(
      { ...request, path: "/API/v1/Auth/Register/" } as unknown as Request,
      current as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledTimes(12);
    expect(current.status).toHaveBeenCalledWith(429);
    expect(current.setHeader).toHaveBeenCalledWith(
      "Retry-After",
      expect.stringMatching(/^\d+$/),
    );
  });
});

describe("stable pagination", () => {
  it("uses a compound key and rejects foreign sort cursors", () => {
    const id = randomUUID();
    const cursor = Buffer.from(
      JSON.stringify({ id, sort: "largest", value: "42000" }),
    ).toString("base64url");
    expect(afterCursor(cursor, "largest")).toEqual({
      OR: [
        { sizeBytes: { lt: 42000n } },
        { sizeBytes: 42000n, id: { lt: id } },
      ],
    });
    expect(() => afterCursor(cursor, "newest")).toThrow("does not match");
    expect(() => afterCursor("corrupt", "largest")).toThrow(
      "Invalid page cursor",
    );
  });
});

describe("S3 presigning", () => {
  it("binds the browser endpoint, upload ID, part number, expiry, and exact body length", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "local");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "local-local");
    const storage = new Storage(config);
    try {
      const signed = new URL(
        await storage.signPart(
          "originals/test/source",
          "test-upload",
          3,
          7654321,
        ),
      );
      expect(signed.origin).toBe("http://localhost:9000");
      expect(signed.pathname).toBe("/streamforge/originals/test/source");
      expect(signed.searchParams.get("uploadId")).toBe("test-upload");
      expect(signed.searchParams.get("partNumber")).toBe("3");
      expect(signed.searchParams.get("X-Amz-Expires")).toBe("900");
      expect(
        signed.searchParams.get("X-Amz-SignedHeaders")?.split(";"),
      ).toContain("content-length");
    } finally {
      storage.onApplicationShutdown();
      vi.unstubAllEnvs();
    }
  });
});

describe("S3 part listing", () => {
  it("stops on a nontruncated page even when the emulator returns a zero marker", async () => {
    const storage = new Storage(config);
    const send = vi.fn().mockResolvedValue({
      IsTruncated: false,
      NextPartNumberMarker: "0",
    });
    Reflect.set(Reflect.get(storage, "s3"), "send", send);
    try {
      await expect(
        storage.parts("originals/test/source", "multipart-id"),
      ).resolves.toEqual([]);
      expect(send).toHaveBeenCalledOnce();
    } finally {
      storage.onApplicationShutdown();
    }
  });

  it("advances through truncated pages and rejects a repeated marker", async () => {
    const storage = new Storage(config);
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        IsTruncated: true,
        NextPartNumberMarker: "1",
        Parts: [{ PartNumber: 1, ETag: '"one"', Size: 100 }],
      })
      .mockResolvedValueOnce({
        IsTruncated: true,
        NextPartNumberMarker: "1",
      });
    Reflect.set(Reflect.get(storage, "s3"), "send", send);
    try {
      await expect(
        storage.parts("originals/test/source", "multipart-id"),
      ).rejects.toThrow("invalid multipart pagination marker");
      expect(send).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          input: expect.objectContaining({ PartNumberMarker: "1" }),
        }),
      );
    } finally {
      storage.onApplicationShutdown();
    }
  });
});
