import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeMedia,
  type MediaOptions,
  probeSource,
  selectRenditions,
  verifyVariant,
} from "../src/media.js";
import { runProcess } from "../src/process.js";

describe("rendition selection", () => {
  it("caps 4K and supports landscape and portrait ladders without upscaling", () => {
    expect(
      selectRenditions(3840, 2160).map(({ width, height }) => [width, height]),
    ).toEqual([
      [1920, 1080],
      [1280, 720],
      [852, 480],
    ]);
    expect(
      selectRenditions(1080, 1920).map(({ width, height }) => [width, height]),
    ).toEqual([
      [1080, 1920],
      [720, 1280],
      [480, 852],
    ]);
  });

  it("deduplicates low-resolution variants and rounds odd dimensions down to even pixels", () => {
    expect(selectRenditions(321, 203)).toEqual([
      { width: 320, height: 202, targetBitrate: 156_000 },
    ]);
  });
});

describe("real FFmpeg processing", () => {
  const tempRoot = tmpdir();
  let workspace: string;
  let options: MediaOptions;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tempRoot, "streamforge-media-test-"));
    options = {
      ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
      ffprobe: process.env.FFPROBE_PATH || "ffprobe",
      threads: 2,
      maxDurationSeconds: 60,
      timeoutMs: 60_000,
      signal: AbortSignal.timeout(90_000),
    };
  });

  afterEach(async () => {
    if (workspace && dirname(workspace) === tempRoot) {
      await rm(workspace, { force: true, recursive: true, maxRetries: 3 });
    }
  });

  async function generate(
    width: number,
    height: number,
    seconds: number,
    audio: boolean,
    odd = false,
  ) {
    const file = join(workspace, "input.mp4");
    const filter = odd ? "testsrc" : "testsrc2";
    const soundtrack = audio
      ? ["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000"]
      : [];
    await runProcess(
      options.ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-filter_threads",
        "2",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `${filter}=size=${width}x${height}:rate=12`,
        ...soundtrack,
        "-t",
        String(seconds),
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-threads",
        "2",
        "-pix_fmt",
        odd ? "yuv444p" : "yuv420p",
        ...(audio ? ["-c:a", "aac"] : []),
        file,
      ],
      options,
    );
    return file;
  }

  it("encodes and decodes a three-rendition adaptive stream with aligned seek points", async () => {
    const input = await generate(1920, 1080, 8.5, true);
    const metadata = await probeSource(input, options);
    const output = join(workspace, "output");
    const result = await encodeMedia(input, output, metadata, options);
    expect(result.source).toMatchObject({
      width: 1920,
      height: 1080,
      durationSeconds: 8.5,
      audioIndex: 1,
    });
    expect(result.variants.map(({ width, height }) => [width, height])).toEqual(
      [
        [1920, 1080],
        [1280, 720],
        [852, 480],
      ],
    );
    expect(
      result.artifacts.filter(
        ({ contentType }) => contentType === "video/mp2t",
      ),
    ).toHaveLength(9);

    const master = join(output, "master.m3u8");
    const manifest = await readFile(master, "utf8");
    expect(manifest).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    for (const variant of result.variants) {
      expect(manifest).toContain(variant.relativePath);
      const directory = dirname(join(output, variant.relativePath));
      const inspected = await verifyVariant(
        directory,
        dirname(variant.relativePath),
      );
      expect(inspected.segmentDurations).toEqual([4, 4, 0.5]);
    }
    await runProcess(
      options.ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-xerror",
        "-ss",
        "4.25",
        "-i",
        "master.m3u8",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-t",
        "0.25",
        "-f",
        "null",
        "-",
      ],
      { ...options, cwd: output },
    );

    await unlink(join(output, "v0", "segment-000001.ts"));
    await expect(verifyVariant(join(output, "v0"), "v0")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  }, 120_000);

  it("transcodes a short portrait video with no audio and no upscaling", async () => {
    const input = await generate(240, 426, 0.25, false);
    const metadata = await probeSource(input, options);
    const output = join(workspace, "output");
    const result = await encodeMedia(input, output, metadata, options);
    expect(result.source).toMatchObject({
      width: 240,
      height: 426,
      durationSeconds: 0.25,
    });
    expect(result.source.audioIndex).toBeUndefined();
    expect(result.variants).toMatchObject([{ width: 240, height: 426 }]);
    const variant = await verifyVariant(join(output, "v0"), "v0");
    expect(variant.segmentDurations).toEqual([0.25]);
  }, 30_000);

  it("encodes odd source dimensions into an even-sized H.264 transport stream", async () => {
    const input = await generate(321, 203, 0.5, false, true);
    const metadata = await probeSource(input, options);
    const output = join(workspace, "output");
    const result = await encodeMedia(input, output, metadata, options);
    expect(result.source).toMatchObject({ width: 321, height: 203 });
    expect(result.variants).toMatchObject([{ width: 320, height: 202 }]);
    const decoded = await runProcess(
      options.ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,width,height",
        "-of",
        "json",
        join(output, "v0", "segment-000000.ts"),
      ],
      options,
    );
    expect(JSON.parse(decoded).streams).toMatchObject([
      { codec_name: "h264", width: 320, height: 202 },
    ]);
  }, 30_000);

  it("rejects corrupt and playlist inputs before transcoding", async () => {
    const corrupt = join(workspace, "broken.mp4");
    await writeFile(corrupt, Buffer.alloc(128, 0xaa));
    await expect(probeSource(corrupt, options)).rejects.toMatchObject({
      code: "INVALID_MEDIA",
    });
    const playlist = join(workspace, "source.m3u8");
    await writeFile(
      playlist,
      "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nmissing.ts\n#EXT-X-ENDLIST\n",
    );
    await expect(probeSource(playlist, options)).rejects.toMatchObject({
      code: "INVALID_MEDIA",
    });
  });
});
