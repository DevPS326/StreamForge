import { tmpdir } from "node:os";
import { resolve } from "node:path";

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function integer(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function config() {
  return {
    bucket: required("S3_BUCKET"),
    s3Endpoint: process.env.S3_ENDPOINT || undefined,
    sqsEndpoint: process.env.SQS_ENDPOINT || undefined,
    queueUrl: required("SQS_QUEUE_URL"),
    region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
    healthPort: integer("WORKER_HEALTH_PORT", 3011, 1, 65535),
    concurrency: integer("WORKER_CONCURRENCY", 1, 1, 16),
    leaseSeconds: integer("WORKER_LEASE_SECONDS", 90, 30, 900),
    poisonVisibilitySeconds: integer(
      "WORKER_POISON_VISIBILITY_SECONDS",
      60,
      1,
      900,
    ),
    maxAttempts: integer("WORKER_MAX_ATTEMPTS", 5, 1, 15),
    maxDurationSeconds: integer("WORKER_MAX_DURATION_SECONDS", 7200, 1, 86400),
    timeoutMs: integer("WORKER_TIMEOUT_SECONDS", 14400, 30, 39600) * 1000,
    tempDir: resolve(process.env.WORKER_TEMP_DIR || tmpdir()),
    tempBudget: integer(
      "WORKER_TEMP_BUDGET_BYTES",
      16 * 1024 ** 3,
      128 * 1024 ** 2,
      5 * 1024 ** 4,
    ),
    threads: integer("WORKER_FFMPEG_THREADS", 2, 1, 32),
    ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
    ffprobe: process.env.FFPROBE_PATH || "ffprobe",
  };
}

export type WorkerConfig = ReturnType<typeof config>;
