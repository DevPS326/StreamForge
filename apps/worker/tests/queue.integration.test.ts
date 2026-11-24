import { S3Client } from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import db from "@streamforge/db";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { JobRepository } from "../src/jobs.js";
import { ProcessingWorker } from "../src/runner.js";
import { MediaStorage } from "../src/storage.js";

const endpoint = process.env.WORKER_TEST_ELASTICMQ_ENDPOINT;

describe.skipIf(!endpoint)("processing queue redrive on ElasticMQ", () => {
  it("redrives a malformed message without acknowledging it", async () => {
    if (
      !endpoint ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname)
    ) {
      throw new Error(
        "Queue integration tests can only create fixtures on a loopback endpoint",
      );
    }
    const settings = config();
    const queue = new SQSClient({
      region: settings.region,
      endpoint,
      maxAttempts: 1,
    });
    const client = new S3Client({
      region: settings.region,
      endpoint: settings.s3Endpoint,
      forcePathStyle: true,
    });
    const prisma = new db.PrismaClient();
    const stop = new AbortController();
    const name = `streamforge-worker-test-${randomUUID()}`;
    let originalQueue: string | undefined;
    let deadQueue: string | undefined;
    let running: Promise<void> | undefined;

    try {
      const dead = await queue.send(
        new CreateQueueCommand({ QueueName: `${name}-dead` }),
      );
      deadQueue = dead.QueueUrl!;
      const attributes = await queue.send(
        new GetQueueAttributesCommand({
          QueueUrl: deadQueue,
          AttributeNames: ["QueueArn"],
        }),
      );
      const arn = attributes.Attributes?.QueueArn;
      expect(arn).toBeTruthy();

      const original = await queue.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: {
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: arn,
              maxReceiveCount: 2,
            }),
          },
        }),
      );
      originalQueue = original.QueueUrl!;
      const worker = new ProcessingWorker(
        {
          ...settings,
          queueUrl: originalQueue,
          concurrency: 1,
          poisonVisibilitySeconds: 1,
        },
        queue,
        new JobRepository(prisma, 30, 3),
        new MediaStorage(client, settings.bucket),
        stop.signal,
      );
      running = worker.run();
      await queue.send(
        new SendMessageCommand({
          QueueUrl: originalQueue,
          MessageBody: "{invalid message",
        }),
      );

      const deadline = Date.now() + 12_000;
      let poison: string | undefined;
      while (!poison && Date.now() < deadline) {
        const received = await queue.send(
          new ReceiveMessageCommand({
            QueueUrl: deadQueue,
            WaitTimeSeconds: 2,
            MaxNumberOfMessages: 1,
          }),
          { abortSignal: AbortSignal.timeout(4000) },
        );
        poison = received.Messages?.[0]?.Body;
      }
      expect(poison).toBe("{invalid message");
    } finally {
      stop.abort();
      await running;
      for (const url of [originalQueue, deadQueue]) {
        if (url) {
          await queue
            .send(new DeleteQueueCommand({ QueueUrl: url }))
            .catch(() => undefined);
        }
      }
      await prisma.$disconnect();
      client.destroy();
      queue.destroy();
    }
  }, 30_000);
});
