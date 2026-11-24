import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, after } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import db from "@streamforge/db";
import {
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const apiOrigin = process.env.API_PUBLIC_URL ?? "http://localhost:4000";
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const api = `${apiOrigin}/api/v1`;
const storage = new S3Client({
  region: process.env.S3_REGION ?? "us-east-1",
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: Boolean(process.env.S3_ENDPOINT),
  requestChecksumCalculation: "WHEN_REQUIRED",
});
const queue = new SQSClient({
  region: process.env.S3_REGION ?? "us-east-1",
  endpoint: process.env.SQS_ENDPOINT,
});
const prisma = new db.PrismaClient();

after(async () => {
  storage.destroy();
  queue.destroy();
  await prisma.$disconnect();
});

async function request(
  path,
  { method = "GET", cookie, body, status = 200, origin = webOrigin } = {},
) {
  const response = await fetch(api + path, {
    method,
    signal: AbortSignal.timeout(25_000),
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  assert.equal(response.status, status, `${method} ${path} returned ${raw}`);
  return { response, data: raw ? JSON.parse(raw) : null };
}

async function account() {
  const { response, data } = await request("/auth/register", {
    method: "POST",
    status: 201,
    body: {
      email: `test-${randomUUID()}@example.test`,
      password: "Integration-local-test-password!",
      displayName: "Integration test",
    },
  });
  const session = response.headers.get("set-cookie");
  assert.match(session, /HttpOnly/i);
  return { cookie: session.split(";")[0], user: data };
}

async function create(
  cookie,
  size,
  requestKey = randomUUID(),
  filename = "testing.mp4",
) {
  const body = {
    filename,
    mimeType: "video/mp4",
    size,
    title: "Integration playback",
    requestKey,
  };
  const { data: upload } = await request("/uploads", {
    method: "POST",
    cookie,
    body,
    status: 201,
  });
  return { body, upload };
}

async function sendPart(cookie, upload, partNumber, payload) {
  const { data } = await request(`/uploads/${upload.id}/parts`, {
    method: "POST",
    cookie,
    body: { partNumbers: [partNumber] },
  });
  const response = await fetch(data.urls[0].url, {
    method: "PUT",
    body: payload,
  });
  assert.equal(response.status, 200, await response.text());
  assert.ok(response.headers.get("etag"));
}

async function until(read, matches, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (matches(last)) return last;
    await sleep(400);
  } while (Date.now() < deadline);
  assert.fail(
    `State was not reached. Last observed value: ${JSON.stringify(last)}`,
  );
}

function references(manifest) {
  return manifest
    .trim()
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"));
}

test(
  "multipart resumes from storage, concurrent completion dispatches one job, and private HLS is playable and revocable",
  { timeout: 180_000 },
  async () => {
    const { cookie } = await account();
    const outsider = await account();
    const file = "artifacts/integration-landscape.mp4";
    execFileSync(process.execPath, ["scripts/sample.mjs", "landscape", file], {
      stdio: "pipe",
    });
    const base = await readFile(file);
    const padding = Buffer.alloc(10 * 1024 * 1024);
    padding.writeUInt32BE(padding.length);
    padding.write("free", 4);
    const video = Buffer.concat([base, padding]);
    const { body, upload } = await create(cookie, video.length);
    assert.ok(upload.partCount > 1);
    const again = await request("/uploads", {
      method: "POST",
      cookie,
      body,
      status: 201,
    });
    assert.equal(again.data.id, upload.id);
    await request(`/uploads/${upload.id}`, {
      cookie: outsider.cookie,
      status: 404,
    });
    await request(`/videos/${upload.videoId}`, {
      cookie: outsider.cookie,
      status: 404,
    });
    await request(`/uploads/${upload.id}/complete`, {
      method: "POST",
      cookie,
      status: 409,
    });

    const stored = await prisma.uploadSession.findUniqueOrThrow({
      where: { id: upload.id },
      include: { video: true },
    });
    const expired = await getSignedUrl(
      storage,
      new UploadPartCommand({
        Bucket: process.env.S3_BUCKET,
        Key: stored.video.originalKey,
        UploadId: stored.storageUploadId,
        PartNumber: 1,
      }),
      { expiresIn: 60, signingDate: new Date(Date.now() - 7_200_000) },
    );
    assert.equal(
      (
        await fetch(expired, {
          method: "PUT",
          body: video.subarray(0, upload.partSize),
        })
      ).status,
      403,
    );
    await sendPart(cookie, upload, 1, video.subarray(0, upload.partSize));
    const resumed = await request(`/uploads/${upload.id}`, { cookie });
    assert.deepEqual(
      resumed.data.parts.map(({ partNumber }) => partNumber),
      [1],
    );
    for (let number = 2; number <= upload.partCount; number++) {
      await sendPart(
        cookie,
        upload,
        number,
        video.subarray(
          (number - 1) * upload.partSize,
          number * upload.partSize,
        ),
      );
    }
    const complete = () =>
      fetch(`${api}/uploads/${upload.id}/complete`, {
        method: "POST",
        headers: { Origin: webOrigin, Cookie: cookie },
      });
    const completions = await Promise.all([complete(), complete()]);
    assert.ok(completions.some((response) => response.ok));
    for (const response of completions)
      assert.ok(response.ok || response.status === 409, await response.text());
    assert.ok((await complete()).ok);

    const job = await prisma.processingJob.findUniqueOrThrow({
      where: { videoId: upload.videoId },
    });
    assert.equal(
      await prisma.outbox.count({
        where: { videoId: upload.videoId, kind: "PROCESS_VIDEO" },
      }),
      1,
    );
    await queue.send(
      new SendMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        MessageBody: JSON.stringify({ jobId: job.id, videoId: upload.videoId }),
      }),
    );
    const ready = await until(
      async () => (await request(`/videos/${upload.videoId}`, { cookie })).data,
      ({ status }) => status === "READY",
    );
    assert.equal(ready.width, 1280);
    assert.equal(
      (await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } }))
        .attempts,
      1,
    );
    const master = await fetch(ready.playbackUrl);
    assert.equal(master.status, 200);
    const variants = references(await master.text());
    assert.equal(variants.length, 2);
    const variantUrl = new URL(variants[0], ready.playbackUrl);
    const variant = await fetch(variantUrl);
    assert.equal(variant.status, 200);
    const segments = references(await variant.text());
    assert.ok(segments.length >= 2);
    for (const segment of segments) {
      const segmentUrl = new URL(segment, variantUrl);
      const media = await fetch(segmentUrl);
      assert.equal(media.status, 200);
      assert.ok((await media.arrayBuffer()).byteLength > 0);
      segmentUrl.search = "";
      assert.equal((await fetch(segmentUrl)).status, 404);
    }
    const directBucketObject = `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}/${stored.video.originalKey}`;
    assert.equal((await fetch(directBucketObject)).status, 403);
    const poster = await fetch(ready.thumbnailUrl);
    assert.equal(poster.status, 200);
    assert.match(poster.headers.get("content-type"), /^image\/jpeg/);
    assert.ok((await poster.arrayBuffer()).byteLength > 0);
    const assets = [
      ready.playbackUrl,
      variantUrl,
      ready.thumbnailUrl,
      ...segments.map((segment) => new URL(segment, variantUrl)),
    ];
    for (const asset of assets) {
      const ungranted = new URL(asset);
      ungranted.search = "";
      assert.equal((await fetch(ungranted)).status, 404);
      assert.equal(
        (await fetch(ungranted, { headers: { Cookie: outsider.cookie } }))
          .status,
        404,
      );
    }
    const directBucketPrefix = new URL(
      `/${process.env.S3_BUCKET}/`,
      process.env.S3_ENDPOINT,
    );
    const committed = await prisma.video.findUniqueOrThrow({
      where: { id: upload.videoId },
      select: { mediaPrefix: true },
    });
    assert.ok(committed.mediaPrefix);
    for (const asset of assets) {
      const key = new URL(asset).pathname.split("/").slice(5).join("/");
      assert.equal(
        (
          await fetch(
            new URL(`${committed.mediaPrefix}/${key}`, directBucketPrefix),
          )
        ).status,
        403,
      );
    }

    const { data: share } = await request(`/videos/${upload.videoId}/share`, {
      method: "POST",
      cookie,
      status: 201,
    });
    const guest = await request(`/share/${share.token}`);
    assert.ok((await fetch(guest.data.playbackUrl)).ok);
    await request(`/videos/${upload.videoId}/share`, {
      method: "DELETE",
      cookie,
      status: 204,
    });
    await request(`/share/${share.token}`, { status: 404 });
    assert.equal((await fetch(guest.data.playbackUrl)).status, 404);

    await request(`/videos/${upload.videoId}`, {
      method: "DELETE",
      cookie,
      status: 204,
    });
    await until(
      () =>
        prisma.video.findUniqueOrThrow({
          where: { id: upload.videoId },
          select: { status: true },
        }),
      ({ status }) => status === "DELETED",
    );
    await assert.rejects(
      storage.send(
        new HeadObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: stored.video.originalKey,
        }),
      ),
      (error) => error.$metadata?.httpStatusCode === 404,
    );
    assert.equal((await fetch(ready.playbackUrl)).status, 404);
  },
);

test(
  "cancel aborts multipart and corrupt media reaches a terminal failure",
  { timeout: 120_000 },
  async () => {
    const { cookie } = await account();
    const content = Buffer.alloc(1024, 0x61);
    const { upload: canceled } = await create(cookie, content.length);
    const signed = await request(`/uploads/${canceled.id}/parts`, {
      method: "POST",
      cookie,
      body: { partNumbers: [1] },
    });
    await request(`/uploads/${canceled.id}`, {
      method: "DELETE",
      cookie,
      status: 204,
    });
    await until(
      () =>
        prisma.uploadSession.findUniqueOrThrow({
          where: { id: canceled.id },
          select: { status: true },
        }),
      ({ status }) => status === "ABORTED",
    );
    const late = await fetch(signed.data.urls[0].url, {
      method: "PUT",
      body: content,
    });
    assert.equal(late.status, 404);
    await request(`/uploads/${canceled.id}/complete`, {
      method: "POST",
      cookie,
      status: 409,
    });

    const { upload: corrupt } = await create(cookie, content.length);
    await sendPart(cookie, corrupt, 1, content);
    const response = await fetch(`${api}/uploads/${corrupt.id}/complete`, {
      method: "POST",
      headers: { Origin: webOrigin, Cookie: cookie },
    });
    assert.ok(response.ok, await response.text());
    const failed = await until(
      async () =>
        (await request(`/videos/${corrupt.videoId}`, { cookie })).data,
      ({ status }) => status === "FAILED",
    );
    assert.equal(failed.playbackUrl, null);
    assert.equal(
      await prisma.videoAsset.count({ where: { videoId: corrupt.videoId } }),
      0,
    );
    await request(`/videos/${corrupt.videoId}`, {
      method: "DELETE",
      cookie,
      status: 204,
    });
  },
);

test("session expiry and foreign-origin mutation are rejected", async () => {
  const { cookie, user } = await account();
  await request("/auth/me", { cookie });
  await request("/auth/me", {
    method: "PATCH",
    cookie,
    body: { displayName: "Untrusted" },
    origin: "https://elsewhere.example",
    status: 403,
  });
  await prisma.session.updateMany({
    where: { userId: user.id },
    data: { expiresAt: new Date(0) },
  });
  await request("/auth/me", { cookie, status: 401 });
});
