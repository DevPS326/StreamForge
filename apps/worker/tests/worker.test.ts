import { describe, expect, it, vi } from "vitest";
import { parseQueueJob, retryDelaySeconds } from "../src/jobs.js";
import { runProcess } from "../src/process.js";
import { ScratchBudget } from "../src/storage.js";

describe("safe queue handling", () => {
  it("only accepts bounded job and video IDs", () => {
    expect(parseQueueJob('{"jobId":"job-1","videoId":"video-2"}')).toEqual({
      jobId: "job-1",
      videoId: "video-2",
    });
    for (const value of [
      undefined,
      "{broken",
      "[]",
      "null",
      "{}",
      '{"jobId":"a/b","videoId":"c"}',
      '{"jobId":123,"videoId":"c"}',
      " ".repeat(1025),
    ]) {
      expect(parseQueueJob(value)).toBeNull();
    }
  });

  it("uses exponential backoff with bounded jitter", () => {
    expect(retryDelaySeconds(1, () => 0.5)).toBe(15);
    expect(retryDelaySeconds(2, () => 0.5)).toBe(30);
    expect(retryDelaySeconds(3, () => 0)).toBe(45);
    expect(retryDelaySeconds(3, () => 1)).toBe(75);
    expect(retryDelaySeconds(20, () => 0.5)).toBe(600);
  });
});

describe("worker resource limits", () => {
  it("keeps application credentials out of media subprocess environments", async () => {
    vi.stubEnv("STREAMFORGE_WORKER_TEST_CREDENTIAL", "disposable-sentinel");
    try {
      const result = await runProcess(
        process.execPath,
        [
          "-e",
          "console.log(Boolean(process.env.STREAMFORGE_WORKER_TEST_CREDENTIAL))",
        ],
        { timeoutMs: 5_000, signal: AbortSignal.timeout(10_000) },
      );
      expect(result.trim()).toBe("false");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reserves disk across jobs and releases only its own reservation", () => {
    const budget = new ScratchBudget(100);
    const release = budget.reserve(60);
    expect(() => budget.reserve(41)).toThrow(/reserved/);
    expect(() => budget.reserve(101)).toThrow(/temporary storage limit/);
    const releaseSecond = budget.reserve(40);
    release();
    release();
    expect(() => budget.reserve(61)).toThrow(/reserved/);
    releaseSecond();
    expect(() => budget.reserve(100)).not.toThrow();
  });

  it("awaits child exit when aborting or timing out a process", async () => {
    const controller = new AbortController();
    const processRun = runProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        timeoutMs: 30_000,
        signal: controller.signal,
      },
    );
    controller.abort(new Error("lost lease"));
    await expect(processRun).rejects.toThrow("lost lease");
    await expect(
      runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        timeoutMs: 150,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("exceeded its time limit");
  });
});
