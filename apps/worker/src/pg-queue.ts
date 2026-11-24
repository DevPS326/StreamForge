import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import type { PrismaClient } from "@streamforge/db";
import { setTimeout as pause } from "node:timers/promises";

// SQS-compatible transport over the existing durable ProcessingJob table.
// The real claim/lease/fencing logic stays in JobRepository. Only one worker
// is started in free-demo mode and the database prevents duplicate claims.
export class PostgresJobQueue {
  constructor(
    private readonly db: PrismaClient,
    private readonly stop: AbortSignal,
  ) {}

  async send(
    command: unknown,
    options?: { abortSignal?: AbortSignal },
  ): Promise<any> {
    if (command instanceof ReceiveMessageCommand) {
      const now = new Date();
      const job = await this.db.processingJob.findFirst({
        where: {
          video: { status: "PROCESSING" },
          OR: [
            { status: "PENDING", nextAttemptAt: { lte: now } },
            { status: "RUNNING", leaseExpiresAt: { lte: now } },
          ],
        },
        select: { id: true, videoId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      if (job) {
        return {
          Messages: [
            {
              MessageId: job.id,
              ReceiptHandle: job.id,
              Body: JSON.stringify({ jobId: job.id, videoId: job.videoId }),
            },
          ],
        };
      }
      if (!this.stop.aborted) {
        await pause(2000, undefined, {
          signal: options?.abortSignal ?? this.stop,
        }).catch(() => undefined);
      }
      return { Messages: [] };
    }
    if (command instanceof GetQueueAttributesCommand) {
      return { Attributes: { QueueArn: "arn:streamforge:postgres:free-demo" } };
    }
    if (
      command instanceof ChangeMessageVisibilityCommand ||
      command instanceof DeleteMessageCommand
    ) {
      // ProcessingJob's lease and terminal state provide the acknowledgement.
      return {};
    }
    throw new Error("Unsupported PostgreSQL queue command");
  }

  destroy() {}
}
