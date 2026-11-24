import { randomUUID } from "node:crypto";
import db, { type PrismaClient } from "@streamforge/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attemptPrefix, type ClaimedJob, JobRepository } from "../src/jobs.js";
import type { EncodedMedia } from "../src/media.js";

const databaseUrl = process.env.WORKER_TEST_DATABASE_URL;
const sample: EncodedMedia = {
  source: {
    width: 320,
    height: 180,
    durationSeconds: 1,
    fps: 24,
    videoIndex: 0,
  },
  variants: [
    {
      width: 320,
      height: 180,
      relativePath: "v0/index.m3u8",
      targetBitrate: 150_000,
      peakBandwidth: 110_000,
      averageBandwidth: 100_000,
    },
  ],
  artifacts: [],
};

describe.skipIf(!databaseUrl)(
  "processing job transactions on PostgreSQL",
  () => {
    let prisma: PrismaClient;
    let userId: string;
    let jobs: JobRepository;

    beforeAll(async () => {
      prisma = new db.PrismaClient({ datasourceUrl: databaseUrl });
      const user = await prisma.user.create({
        data: {
          email: `worker-${randomUUID()}@example.test`,
          name: "Worker tests",
          passwordHash: "test-fixture",
        },
      });
      userId = user.id;
      jobs = new JobRepository(prisma, 30, 3);
    });

    afterAll(async () => {
      if (userId) {
        await prisma.video.deleteMany({ where: { userId } });
        await prisma.user.delete({ where: { id: userId } });
      }
      await prisma?.$disconnect();
    });

    async function fixture() {
      const videoId = randomUUID();
      const video = await prisma.video.create({
        data: {
          id: videoId,
          userId,
          title: "Worker test",
          status: "PROCESSING",
          originalKey: `originals/${videoId}/source`,
          sizeBytes: 1024n,
          mimeType: "video/mp4",
          job: { create: {} },
        },
        include: { job: true },
      });
      return { videoId, jobId: video.job!.id };
    }

    async function claim(message: {
      jobId: string;
      videoId: string;
    }): Promise<ClaimedJob> {
      const claim = await jobs.claim(message);
      if (claim.kind !== "claimed")
        throw new Error(`Cannot claim job: ${claim.kind}`);
      return claim.job;
    }

    it(
      "claims concurrent duplicates once and fences a crashed worker after lease expiry",
      { timeout: 20_000 },
      async () => {
        const message = await fixture();
        const duplicateResults = await Promise.all(
          Array.from({ length: 10 }, () => jobs.claim(message)),
        );
        const won = duplicateResults.filter(
          (result) => result.kind === "claimed",
        );
        expect(won).toHaveLength(1);
        const old = won[0]!.job;

        await prisma.processingJob.update({
          where: { id: old.jobId },
          data: { leaseExpiresAt: new Date(Date.now() - 1000) },
        });
        const replacement = await claim(message);
        expect(replacement.previousToken).toBe(old.leaseToken);
        expect(replacement.attempts).toBe(2);
        expect(await jobs.renew(old)).toBe(false);
        expect(await jobs.publish(old, sample)).toBe(false);
        expect(await jobs.publish(replacement, sample)).toBe(true);
        expect((await jobs.claim(message)).kind).toBe("ack");

        const video = await prisma.video.findUniqueOrThrow({
          where: { id: message.videoId },
          include: { assets: true, job: true },
        });
        expect(video.status).toBe("READY");
        expect(video.mediaPrefix).toBe(
          attemptPrefix(message.videoId, replacement.leaseToken).slice(0, -1),
        );
        expect(video.assets).toHaveLength(3);
        expect(video.job?.status).toBe("SUCCEEDED");
      },
    );

    it("rolls back READY and asset rows when publication fails before commit", async () => {
      const message = await fixture();
      const job = await claim(message);
      const invalidAssets = {
        ...sample,
        variants: [sample.variants[0]!, sample.variants[0]!],
      };
      await expect(jobs.publish(job, invalidAssets)).rejects.toMatchObject({
        code: "P2002",
      });

      const video = await prisma.video.findUniqueOrThrow({
        where: { id: message.videoId },
        include: { assets: true, job: true },
      });
      expect(video.status).toBe("PROCESSING");
      expect(video.mediaPrefix).toBeNull();
      expect(video.assets).toEqual([]);
      expect(video.job?.status).toBe("RUNNING");
      expect(
        (
          await jobs.failure(
            job,
            new Error("Simulated transient database failure"),
          )
        ).kind,
      ).toBe("defer");
      expect((await jobs.claim(message)).kind).toBe("defer");
    });

    it("exhausts crashed attempts and prevents publication after deletion begins", async () => {
      const message = await fixture();
      const job = await claim(message);
      const exhausted = new JobRepository(prisma, 30, 1);
      await prisma.processingJob.update({
        where: { id: job.jobId },
        data: { leaseExpiresAt: new Date(0) },
      });
      expect(await exhausted.claim(message)).toEqual({
        kind: "ack",
        reapPrefix: attemptPrefix(job.videoId, job.leaseToken),
      });
      const failure = await prisma.video.findUniqueOrThrow({
        where: { id: message.videoId },
        include: { job: true },
      });
      expect(failure.status).toBe("FAILED");
      expect(failure.job?.status).toBe("FAILED");

      const deletion = await fixture();
      const deleting = await claim(deletion);
      await prisma.$transaction([
        prisma.processingJob.update({
          where: { id: deletion.jobId },
          data: { status: "CANCELLED" },
        }),
        prisma.video.update({
          where: { id: deletion.videoId },
          data: { status: "DELETING" },
        }),
      ]);
      expect(await jobs.renew(deleting)).toBe(false);
      expect(await jobs.publish(deleting, sample)).toBe(false);
      expect((await jobs.claim(deletion)).kind).toBe("ack");
    });
  },
);
