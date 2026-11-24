import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { Outbox } from "@streamforge/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../src/database";
import { OutboxDispatcher } from "../src/outbox";
import type { Storage } from "../src/storage";
import type { Uploads } from "../src/uploads";

type RecordChange = Partial<
  Pick<
    Outbox,
    "availableAt" | "leaseToken" | "leaseExpiresAt" | "sentAt" | "lastError"
  >
> & { attempts?: { increment: number } };

function fixture({ failSend = false, failAcknowledgement = false } = {}) {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const start = new Date("2026-11-19T10:00:00Z");
  vi.setSystemTime(start);

  const videoId = randomUUID();
  const jobId = randomUUID();
  const record: Outbox = {
    id: randomUUID(),
    videoId,
    kind: "PROCESS_VIDEO",
    payload: { videoId, jobId },
    attempts: 0,
    availableAt: start,
    createdAt: start,
    leaseToken: null,
    leaseExpiresAt: null,
    sentAt: null,
    lastError: null,
  };
  const findMany = vi.fn(
    async ({ where }: { where: { availableAt: { lte: Date } } }) => {
      return !record.sentAt && record.availableAt <= where.availableAt.lte
        ? [{ ...record }]
        : [];
    },
  );
  const updateMany = vi.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string; leaseToken?: string };
      data: RecordChange;
    }) => {
      if (
        where.id !== record.id ||
        (where.leaseToken && where.leaseToken !== record.leaseToken)
      ) {
        return { count: 0 };
      }
      if (data.sentAt && failAcknowledgement) {
        failAcknowledgement = false;
        throw new Error("database unavailable after queue accepted dispatch");
      }
      const { attempts, ...changes } = data;
      Object.assign(record, changes);
      record.attempts += attempts?.increment ?? 0;
      return { count: 1 };
    },
  );
  const enqueue = vi.fn().mockResolvedValue(undefined);
  if (failSend) {
    const error = new Error("queue overloaded");
    error.name = "ThrottlingException";
    enqueue.mockRejectedValueOnce(error);
  }
  const dispatcher = new OutboxDispatcher(
    {
      outbox: { findMany, updateMany },
      processingJob: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as Database,
    { enqueue } as unknown as Storage,
    { reconcile: vi.fn().mockResolvedValue(undefined) } as unknown as Uploads,
  );
  return { dispatcher, enqueue, record, start, jobId };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("durable outbox dispatch", () => {
  it("keeps a throttled SQS send unsent and retries using a new lease after the persisted backoff", async () => {
    const { dispatcher, enqueue, record, start, jobId } = fixture({
      failSend: true,
    });
    dispatcher.onApplicationBootstrap();
    try {
      await vi.advanceTimersByTimeAsync(1_999);
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(jobId, record.videoId);
      expect(record).toMatchObject({
        attempts: 1,
        availableAt: new Date(start.getTime() + 2_000),
        leaseToken: null,
        leaseExpiresAt: null,
        sentAt: null,
        lastError: "ThrottlingException",
      });
      await vi.advanceTimersByTimeAsync(2);
      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(record).toMatchObject({
        attempts: 2,
        sentAt: new Date(start.getTime() + 2_000),
        leaseToken: null,
        lastError: null,
      });
    } finally {
      await dispatcher.onModuleDestroy();
    }
  });

  it("redelivers the same job after the queue accepted dispatch but recording success failed", async () => {
    const { dispatcher, enqueue, record, jobId } = fixture({
      failAcknowledgement: true,
    });
    dispatcher.onApplicationBootstrap();
    try {
      await vi.advanceTimersByTimeAsync(1_999);
      expect(record.sentAt).toBeNull();
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(jobId, record.videoId);
      await vi.advanceTimersByTimeAsync(2);
      expect(enqueue.mock.calls).toEqual([
        [jobId, record.videoId],
        [jobId, record.videoId],
      ]);
      expect(record.sentAt).toBeInstanceOf(Date);
      expect(record.attempts).toBe(2);
    } finally {
      await dispatcher.onModuleDestroy();
    }
  });
});
