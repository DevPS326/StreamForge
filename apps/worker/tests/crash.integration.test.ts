import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import db from "@streamforge/db";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { runProcess } from "../src/process.js";
import { scratchPrefix } from "../src/storage.js";

const enabled = process.env.WORKER_TEST_CRASH === "1";
const databaseUrl = process.env.WORKER_TEST_DATABASE_URL;

function loopback(url: string | undefined) {
  return (
    !!url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)
  );
}

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Cannot allocate local worker health port");
  server.close();
  await once(server, "close");
  return address.port;
}

async function until<T>(
  find: () => Promise<T | undefined>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await find();
    if (result !== undefined) return result;
    await pause(100);
  }
  throw new Error(message);
}

async function terminate(worker: ChildProcess | undefined) {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  const exited = once(worker, "exit");
  worker.kill("SIGKILL");
  await exited;
}

describe.skipIf(!enabled)("real worker crash recovery", () => {
  it("publishes from the redelivered message after the transcoding process is killed", async () => {
    const settings = config();
    if (
      ![databaseUrl, settings.s3Endpoint, settings.sqsEndpoint].every(loopback)
    ) {
      throw new Error(
        "Crash tests require loopback PostgreSQL, MinIO and ElasticMQ endpoints",
      );
    }
    const tempRoot = tmpdir();
    const scratch = await mkdtemp(join(tempRoot, "streamforge-crash-test-"));
    const prisma = new db.PrismaClient({ datasourceUrl: databaseUrl });
    const queue = new SQSClient({
      region: settings.region,
      endpoint: settings.sqsEndpoint,
    });
    const storage = new S3Client({
      region: settings.region,
      endpoint: settings.s3Endpoint,
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    const videoId = randomUUID();
    const originalKey = `originals/${videoId}/source`;
    let queueUrl: string | undefined;
    let userId: string | undefined;
    let worker: ChildProcess | undefined;

    async function startWorker(workingDir: string) {
      const port = await freePort();
      worker = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          SQS_QUEUE_URL: queueUrl,
          WORKER_HEALTH_PORT: String(port),
          WORKER_TEMP_DIR: workingDir,
          WORKER_CONCURRENCY: "1",
          WORKER_LEASE_SECONDS: "30",
          WORKER_FFMPEG_THREADS: "2",
        },
      });
      await until(
        async () => {
          if (worker?.exitCode !== null)
            throw new Error("Worker exited before readiness");
          const response = await fetch(`http://127.0.0.1:${port}/ready`).catch(
            () => undefined,
          );
          return response?.ok || undefined;
        },
        15_000,
        "Worker did not become ready",
      );
    }

    try {
      const fixture = join(scratch, "fixture.mp4");
      const firstScratch = join(scratch, "first-worker");
      await mkdir(firstScratch);
      await runProcess(
        settings.ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=1280x720:rate=24",
          "-t",
          "16",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-threads",
          "2",
          fixture,
        ],
        { timeoutMs: 35_000, signal: AbortSignal.timeout(40_000) },
      );

      const created = await queue.send(
        new CreateQueueCommand({
          QueueName: `streamforge-worker-crash-${videoId}`,
        }),
      );
      queueUrl = created.QueueUrl;
      if (!queueUrl)
        throw new Error("ElasticMQ did not create the fixture queue");
      const user = await prisma.user.create({
        data: {
          email: `worker-crash-${videoId}@example.test`,
          name: "Crash test",
          passwordHash: "fixture",
        },
      });
      userId = user.id;
      const { size } = await stat(fixture);
      const video = await prisma.video.create({
        data: {
          id: videoId,
          userId,
          title: "Worker crash fixture",
          status: "PROCESSING",
          originalKey,
          mimeType: "video/mp4",
          sizeBytes: BigInt(size),
          job: { create: {} },
        },
        include: { job: true },
      });
      const jobId = video.job!.id;
      await storage.send(
        new PutObjectCommand({
          Bucket: settings.bucket,
          Key: originalKey,
          Body: createReadStream(fixture),
          ContentLength: size,
          ContentType: "video/mp4",
        }),
      );

      await startWorker(firstScratch);
      await queue.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ videoId, jobId }),
        }),
      );
      await until(
        async () => {
          const folder = (await readdir(firstScratch)).find((entry) =>
            entry.startsWith(scratchPrefix),
          );
          if (!folder) return undefined;
          const files = await readdir(
            join(firstScratch, folder, "output", "v0"),
          ).catch(() => []);
          return (
            files.some((file) => /^segment-000000\.ts(?:\.tmp)?$/.test(file)) ||
            undefined
          );
        },
        35_000,
        "FFmpeg did not start writing its first HLS rendition",
      );

      await terminate(worker);
      const interrupted = await prisma.processingJob.findUniqueOrThrow({
        where: { id: jobId },
      });
      expect(interrupted).toMatchObject({ status: "RUNNING", attempts: 1 });
      expect(interrupted.leaseToken).toBeTruthy();

      await startWorker(join(scratch, "replacement-worker"));
      const ready = await until(
        async () => {
          const current = await prisma.video.findUniqueOrThrow({
            where: { id: videoId },
            include: { job: true, assets: true },
          });
          if (current.status === "FAILED")
            throw new Error(
              current.job?.lastError ?? "Replacement worker failed",
            );
          return current.status === "READY" ? current : undefined;
        },
        75_000,
        "Replacement worker did not publish the redelivered job",
      );
      expect(ready.job).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
      expect(ready.mediaPrefix).not.toContain(interrupted.leaseToken);
      const master = ready.assets.find((asset) => asset.kind === "MASTER");
      const published = await storage.send(
        new HeadObjectCommand({ Bucket: settings.bucket, Key: master?.key }),
      );
      expect(published.ContentType).toBe("application/vnd.apple.mpegurl");
    } finally {
      await terminate(worker);
      if (queueUrl)
        await queue.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      if (userId) {
        const listed = await storage.send(
          new ListObjectsV2Command({
            Bucket: settings.bucket,
            Prefix: `media/${videoId}/`,
          }),
        );
        await storage.send(
          new DeleteObjectsCommand({
            Bucket: settings.bucket,
            Delete: {
              Objects: [
                { Key: originalKey },
                ...(listed.Contents ?? []).map(({ Key }) => ({ Key })),
              ],
            },
          }),
        );
        await prisma.video.deleteMany({ where: { userId, id: videoId } });
        await prisma.user.delete({ where: { id: userId } });
      }
      await prisma.$disconnect();
      storage.destroy();
      queue.destroy();
      if (dirname(scratch) === tempRoot)
        await rm(scratch, { recursive: true, force: true, maxRetries: 10 });
    }
  }, 140_000);
});
