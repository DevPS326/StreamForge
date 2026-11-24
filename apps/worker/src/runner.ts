import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { WorkerConfig } from "./config.js";
import {
  attemptPrefix,
  type ClaimedJob,
  type JobRepository,
  parseQueueJob,
  type QueueAction,
} from "./jobs.js";
import { errorText, log } from "./log.js";
import {
  encodeMedia,
  estimatedOutputBytes,
  MediaError,
  probeSource,
} from "./media.js";
import {
  type MediaStorage,
  requireDiskSpace,
  ScratchBudget,
  scratchPrefix,
} from "./storage.js";

const queueCallTimeout = 10_000;

export class ProcessingWorker {
  private readonly running = new Set<Promise<void>>();
  private readonly budget: ScratchBudget;

  constructor(
    private readonly config: WorkerConfig,
    private readonly queue: SQSClient,
    private readonly jobs: JobRepository,
    private readonly storage: MediaStorage,
    private readonly stop: AbortSignal,
  ) {
    this.budget = new ScratchBudget(config.tempBudget);
  }

  async run() {
    while (!this.stop.aborted) {
      if (this.running.size >= this.config.concurrency) {
        await Promise.race(this.running);
        continue;
      }

      try {
        const received = await this.queue.send(
          new ReceiveMessageCommand({
            QueueUrl: this.config.queueUrl,
            MaxNumberOfMessages: Math.min(
              10,
              this.config.concurrency - this.running.size,
            ),
            WaitTimeSeconds: 20,
            VisibilityTimeout: this.config.leaseSeconds,
          }),
          {
            abortSignal: AbortSignal.any([
              this.stop,
              AbortSignal.timeout(30_000),
            ]),
          },
        );
        if (this.stop.aborted) break;

        for (const message of received.Messages ?? []) {
          const handling = this.handle(message)
            .catch((error) =>
              log("error", "message_handling_failed", {
                messageId: message.MessageId,
                error: errorText(error),
              }),
            )
            .finally(() => this.running.delete(handling));
          this.running.add(handling);
        }
      } catch (error) {
        if (this.stop.aborted) break;
        log("error", "queue_poll_failed", { error: errorText(error) });
        await pause(3000, undefined, { signal: this.stop }).catch(
          () => undefined,
        );
      }
    }

    await Promise.allSettled(this.running);
  }

  private changeVisibility(
    receipt: string,
    seconds: number,
    signal: AbortSignal,
  ) {
    return this.queue.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.config.queueUrl,
        ReceiptHandle: receipt,
        VisibilityTimeout: seconds,
      }),
      {
        abortSignal: AbortSignal.any([
          signal,
          AbortSignal.timeout(queueCallTimeout),
        ]),
      },
    );
  }

  private async handle(message: Message) {
    const receipt = message.ReceiptHandle;
    if (!receipt) return;

    const event = parseQueueJob(message.Body);
    if (!event) {
      log("warn", "invalid_processing_message", {
        messageId: message.MessageId,
      });
      await this.changeVisibility(
        receipt,
        this.config.poisonVisibilitySeconds,
        this.stop,
      );
      return;
    }

    const claim = await this.jobs.claim(event);
    const result =
      claim.kind === "claimed" ? await this.process(claim.job, receipt) : claim;
    if (this.stop.aborted) return;
    if (result.kind === "defer")
      await this.changeVisibility(receipt, result.seconds, this.stop);
    if (result.kind === "ack") {
      if (result.reapPrefix)
        await this.cleanup(event.videoId, result.reapPrefix);
      await this.queue.send(
        new DeleteMessageCommand({
          QueueUrl: this.config.queueUrl,
          ReceiptHandle: receipt,
        }),
        {
          abortSignal: AbortSignal.any([
            this.stop,
            AbortSignal.timeout(queueCallTimeout),
          ]),
        },
      );
    }
  }

  private async heartbeat(
    job: ClaimedJob,
    receipt: string,
    ending: AbortSignal,
    operation: AbortController,
    renewGuard: (deadline: Date) => void,
  ) {
    const signal = AbortSignal.any([ending, this.stop, operation.signal]);
    const heartbeatMs = Math.round((this.config.leaseSeconds * 1000) / 3);
    try {
      while (!signal.aborted) {
        await pause(heartbeatMs, undefined, { signal });
        const deadline = await this.jobs.renew(job);
        if (!deadline) throw new Error("Processing lease was lost");
        signal.throwIfAborted();
        await this.changeVisibility(receipt, this.config.leaseSeconds, signal);
        renewGuard(deadline);
      }
    } catch (error) {
      if (signal.aborted) return;
      operation.abort(error);
      log("warn", "processing_lease_lost", {
        ...this.logFields(job),
        error: errorText(error),
      });
    }
  }

  private logFields(job: ClaimedJob) {
    return { jobId: job.jobId, videoId: job.videoId, attempt: job.attempts };
  }

  private async process(
    job: ClaimedJob,
    receipt: string,
  ): Promise<QueueAction> {
    const fields = this.logFields(job);
    log("info", "processing_started", fields);

    const operation = new AbortController();
    const ending = new AbortController();
    const signal = AbortSignal.any([
      this.stop,
      operation.signal,
      AbortSignal.timeout(this.config.timeoutMs),
    ]);
    let leaseGuard: ReturnType<typeof setTimeout> | undefined;
    const renewGuard = (deadline: Date) => {
      clearTimeout(leaseGuard);
      leaseGuard = setTimeout(
        () => {
          log("warn", "processing_lease_timed_out", fields);
          operation.abort(new Error("Processing lease deadline elapsed"));
        },
        Math.max(0, +deadline - Date.now() - 1000),
      );
    };
    renewGuard(job.initialLeaseDeadline);
    const heartbeat = this.heartbeat(
      job,
      receipt,
      ending.signal,
      operation,
      renewGuard,
    );
    const interrupted = AbortSignal.any([this.stop, operation.signal]);
    const heartbeatFinished = Promise.race([
      heartbeat,
      once(interrupted, "abort"),
    ]);
    const endHeartbeat = async () => {
      ending.abort();
      await heartbeatFinished;
    };
    const prefix = attemptPrefix(job.videoId, job.leaseToken);
    let published = false;
    let remoteStarted = false;
    let workingDirectory: string | undefined;
    let releaseSource: (() => void) | undefined;
    let releaseOutput: (() => void) | undefined;

    try {
      if (job.previousToken)
        await this.cleanup(
          job.videoId,
          attemptPrefix(job.videoId, job.previousToken),
        );
      const sourceBytes = Number(job.sizeBytes);
      if (process.env.DEMO_FREE_MODE === "1" && sourceBytes > 20 * 1024 * 1024)
        throw new MediaError(
          "MEDIA_LIMIT_EXCEEDED",
          "Free demo maximum is 20 MiB per video",
        );
      releaseSource = this.budget.reserve(sourceBytes);
      await requireDiskSpace(this.config.tempDir, sourceBytes);
      workingDirectory = await mkdtemp(
        join(this.config.tempDir, scratchPrefix),
      );
      const sourcePath = join(workingDirectory, "source");
      const output = join(workingDirectory, "output");
      await this.storage.download(
        job.originalKey,
        sourceBytes,
        sourcePath,
        signal,
      );

      const options = {
        ffmpeg: this.config.ffmpeg,
        ffprobe: this.config.ffprobe,
        maxDurationSeconds: this.config.maxDurationSeconds,
        timeoutMs: this.config.timeoutMs,
        threads: this.config.threads,
        signal,
      };
      const metadata = await probeSource(sourcePath, options);
      const outputBytes = estimatedOutputBytes(metadata);
      if (sourceBytes + outputBytes > this.budget.capacity) {
        throw new MediaError(
          "MEDIA_LIMIT_EXCEEDED",
          "The video exceeds the worker temporary storage limit",
        );
      }
      releaseOutput = this.budget.reserve(outputBytes);
      await requireDiskSpace(this.config.tempDir, outputBytes);
      const encoded = await encodeMedia(sourcePath, output, metadata, options);
      remoteStarted = true;
      await this.storage.uploadVerified(
        prefix,
        output,
        encoded.artifacts,
        signal,
      );

      signal.throwIfAborted();
      await endHeartbeat();
      signal.throwIfAborted();
      published = await this.jobs.publish(job, encoded);
      if (!published) return { kind: "redeliver" };

      log("info", "processing_completed", {
        ...fields,
        variants: encoded.variants.length,
        artifacts: encoded.artifacts.length,
      });
      return { kind: "ack" };
    } catch (error) {
      await endHeartbeat();
      if (this.stop.aborted || operation.signal.aborted)
        return { kind: "redeliver" };
      const action = await this.jobs.failure(job, error);
      log(action.kind === "ack" ? "error" : "warn", "processing_failed", {
        ...fields,
        error: errorText(error),
        terminal: action.kind === "ack",
      });
      return action;
    } finally {
      await endHeartbeat();
      clearTimeout(leaseGuard);
      if (
        workingDirectory &&
        dirname(workingDirectory) === this.config.tempDir
      ) {
        await rm(workingDirectory, {
          recursive: true,
          force: true,
          maxRetries: 3,
        }).catch((error) => {
          log("error", "scratch_cleanup_failed", {
            ...fields,
            error: errorText(error),
          });
        });
      }
      releaseSource?.();
      releaseOutput?.();
      if (remoteStarted && !published) await this.cleanup(job.videoId, prefix);
    }
  }

  private async cleanup(videoId: string, prefix: string) {
    if (this.stop.aborted) return;
    try {
      // A database connection can fail after COMMIT, so confirm the prefix is unpublished before deleting.
      if (!(await this.jobs.isPublished(videoId, prefix))) {
        await this.storage.deleteAttempt(
          prefix,
          AbortSignal.any([this.stop, AbortSignal.timeout(queueCallTimeout)]),
        );
      }
    } catch (error) {
      if (this.stop.aborted) return;
      log("warn", "orphan_cleanup_failed", {
        videoId,
        prefix,
        error: errorText(error),
      });
    }
  }
}
