import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import db from "@streamforge/db";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { config } from "./config.js";
import { JobRepository } from "./jobs.js";
import { errorText, log } from "./log.js";
import { runProcess } from "./process.js";
import { ProcessingWorker } from "./runner.js";
import { MediaStorage, removeAbandonedScratch } from "./storage.js";

async function main() {
  const settings = config();
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log("info", "worker_shutdown", { signal });
      stop.abort();
    });
  }

  await mkdir(settings.tempDir, { recursive: true });
  await removeAbandonedScratch(settings.tempDir).catch((error) => {
    log("warn", "abandoned_scratch_cleanup_failed", {
      error: errorText(error),
    });
  });
  const startupOptions = { timeoutMs: 10_000, signal: stop.signal };
  const [encoders] = await Promise.all([
    runProcess(settings.ffmpeg, ["-hide_banner", "-encoders"], startupOptions),
    runProcess(settings.ffprobe, ["-version"], startupOptions),
  ]);
  if (
    !/^\s*V\S{5}\s+libx264\s/m.test(encoders) ||
    !/^\s*A\S{5}\s+aac\s/m.test(encoders)
  ) {
    throw new Error("FFmpeg must provide the libx264 and AAC encoders");
  }

  const prisma = new db.PrismaClient();
  const client = new S3Client({
    region: settings.region,
    endpoint: settings.s3Endpoint,
    forcePathStyle: !!settings.s3Endpoint,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const queue = new SQSClient({
    region: settings.region,
    endpoint: settings.sqsEndpoint,
  });
  const jobs = new JobRepository(
    prisma,
    settings.leaseSeconds,
    settings.maxAttempts,
  );
  const worker = new ProcessingWorker(
    settings,
    queue,
    jobs,
    new MediaStorage(client, settings.bucket),
    stop.signal,
  );
  let readyAt = 0;
  let checking = false;

  const refreshReadiness = async () => {
    if (checking || stop.signal.aborted) return;
    checking = true;
    const abortSignal = AbortSignal.any([
      stop.signal,
      AbortSignal.timeout(5000),
    ]);
    try {
      await Promise.all([
        prisma.$queryRaw`SELECT 1`,
        client.send(
          new ListObjectsV2Command({
            Bucket: settings.bucket,
            Prefix: "media/",
            MaxKeys: 1,
          }),
          { abortSignal },
        ),
        queue.send(
          new GetQueueAttributesCommand({
            QueueUrl: settings.queueUrl,
            AttributeNames: ["QueueArn"],
          }),
          { abortSignal },
        ),
      ]);
      readyAt = Date.now();
    } catch (error) {
      if (readyAt && !stop.signal.aborted)
        log("warn", "worker_readiness_lost", { error: errorText(error) });
      readyAt = 0;
    } finally {
      checking = false;
    }
  };
  const server = createServer((request, response) => {
    let status = 404;
    if (request.url === "/health") status = stop.signal.aborted ? 503 : 200;
    if (request.url === "/ready")
      status =
        !stop.signal.aborted && Date.now() - readyAt < 45_000 ? 200 : 503;
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(
      JSON.stringify({ status: status === 200 ? "ok" : "unavailable" }),
    );
  });

  const readiness = setInterval(() => {
    void refreshReadiness();
  }, 15_000);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(settings.healthPort, "127.0.0.1", resolve);
    });
    void refreshReadiness();
    log("info", "worker_started", {
      concurrency: settings.concurrency,
      healthPort: settings.healthPort,
    });
    await worker.run();
  } finally {
    stop.abort();
    clearInterval(readiness);
    server.close();
    server.closeAllConnections();
    client.destroy();
    queue.destroy();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  log("error", "worker_startup_failed", { error: errorText(error) });
  process.exitCode = 1;
});
