import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ProcessError, runProcess } from "./process.js";

const segmentSeconds = 4;
const supportedFormats =
  "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,mpeg,m4v,flv,ogg";
const supportedVideoCodecs = new Set([
  "h264",
  "hevc",
  "vp8",
  "vp9",
  "av1",
  "mpeg1video",
  "mpeg2video",
  "mpeg4",
  "mjpeg",
  "prores",
  "theora",
]);
const maxSourceDimension = 8192;
const maxSourcePixels = 38_000_000;

export class MediaError extends Error {
  constructor(
    readonly code:
      "INVALID_MEDIA" | "UNSUPPORTED_MEDIA" | "MEDIA_LIMIT_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

type ProbeStream = {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_aspect_ratio?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: { rotation?: number }[];
  tags?: { rotate?: string };
};

export type SourceMedia = {
  width: number;
  height: number;
  durationSeconds: number;
  fps: number;
  videoIndex: number;
  audioIndex?: number;
};

export type Rendition = {
  width: number;
  height: number;
  targetBitrate: number;
};

export type Artifact = {
  relativePath: string;
  length: number;
  contentType: string;
};

export type Variant = Rendition & {
  relativePath: string;
  peakBandwidth: number;
  averageBandwidth: number;
};

export type EncodedMedia = {
  source: SourceMedia;
  variants: Variant[];
  artifacts: Artifact[];
};

export type MediaOptions = {
  ffmpeg: string;
  ffprobe: string;
  maxDurationSeconds: number;
  timeoutMs: number;
  threads: number;
  signal: AbortSignal;
};

function positiveRatio(value: string | undefined, separator: string): number {
  const [numerator, denominator] = (value ?? "").split(separator).map(Number);
  if (!numerator || !denominator) return 0;
  const ratio = numerator / denominator;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
}

export async function probeSource(
  path: string,
  options: MediaOptions,
): Promise<SourceMedia> {
  let stdout: string;
  try {
    stdout = await runProcess(
      options.ffprobe,
      [
        "-v",
        "error",
        "-max_alloc",
        "268435456",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        supportedFormats,
        "-probesize",
        "33554432",
        "-analyzeduration",
        "10000000",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        path,
      ],
      {
        timeoutMs: Math.min(60_000, options.timeoutMs),
        signal: options.signal,
      },
    );
  } catch (error) {
    if (!(error instanceof ProcessError)) throw error;
    throw new MediaError("INVALID_MEDIA", error.message);
  }

  const metadata = JSON.parse(stdout) as {
    streams?: ProbeStream[];
    format?: { duration?: string };
  };
  const video = metadata.streams?.find(
    (stream) =>
      stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  if (!video?.width || !video.height) {
    throw new MediaError(
      "INVALID_MEDIA",
      "The file has no playable video stream",
    );
  }
  if (!supportedVideoCodecs.has(video.codec_name ?? "")) {
    throw new MediaError(
      "UNSUPPORTED_MEDIA",
      `Unsupported video codec ${video.codec_name ?? "unknown"}`,
    );
  }
  if (
    video.width < 2 ||
    video.height < 2 ||
    video.width > maxSourceDimension ||
    video.height > maxSourceDimension ||
    video.width * video.height > maxSourcePixels
  ) {
    throw new MediaError(
      "MEDIA_LIMIT_EXCEEDED",
      "Source dimensions exceed the processing limit",
    );
  }
  const streamDuration = Number(video.duration);
  const duration =
    streamDuration > 0 ? streamDuration : Number(metadata.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MediaError(
      "INVALID_MEDIA",
      "A positive media duration could not be determined",
    );
  }
  if (duration > options.maxDurationSeconds) {
    throw new MediaError(
      "MEDIA_LIMIT_EXCEEDED",
      "Video exceeds the processing duration limit",
    );
  }

  const pixelAspect = positiveRatio(video.sample_aspect_ratio, ":") || 1;
  const displayedWidth = Math.round(video.width * pixelAspect);
  if (displayedWidth < 2 || displayedWidth > maxSourceDimension) {
    throw new MediaError(
      "MEDIA_LIMIT_EXCEEDED",
      "Display dimensions exceed the processing limit",
    );
  }
  const rotation =
    video.side_data_list?.find((entry) => entry.rotation !== undefined)
      ?.rotation ?? Number(video.tags?.rotate ?? 0);
  const rotated = Math.abs(rotation % 180) === 90;
  const audio = metadata.streams?.find(
    (stream) => stream.codec_type === "audio",
  );
  const fps =
    positiveRatio(video.avg_frame_rate, "/") ||
    positiveRatio(video.r_frame_rate, "/") ||
    30;

  return {
    width: rotated ? video.height : displayedWidth,
    height: rotated ? displayedWidth : video.height,
    durationSeconds: duration,
    fps: Math.min(60, Math.max(1, Math.round(fps))),
    videoIndex: video.index,
    audioIndex: audio?.index,
  };
}

function evenDimension(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export function selectRenditions(width: number, height: number): Rendition[] {
  const landscape = width >= height;
  const candidates = [
    { short: 1080, long: 1920, bitrate: 5_000_000 },
    { short: 720, long: 1280, bitrate: 2_800_000 },
    { short: 480, long: 854, bitrate: 1_200_000 },
  ];
  const renditions: Rendition[] = [];

  for (const candidate of candidates) {
    const maxWidth = landscape ? candidate.long : candidate.short;
    const maxHeight = landscape ? candidate.short : candidate.long;
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    const outputWidth = evenDimension(width * scale);
    const outputHeight = evenDimension(height * scale);
    if (
      renditions.some(
        (rendition) =>
          rendition.width === outputWidth && rendition.height === outputHeight,
      )
    ) {
      continue;
    }
    const pixelRatio = (outputWidth * outputHeight) / (maxWidth * maxHeight);
    renditions.push({
      width: outputWidth,
      height: outputHeight,
      targetBitrate: Math.max(
        150_000,
        Math.round((candidate.bitrate * Math.min(1, pixelRatio)) / 1000) * 1000,
      ),
    });
  }

  return renditions;
}

export function estimatedOutputBytes(source: SourceMedia): number {
  const bitrate = selectRenditions(source.width, source.height).reduce(
    (sum, entry) =>
      sum +
      entry.targetBitrate +
      (source.audioIndex === undefined ? 0 : 128_000),
    0,
  );
  return Math.ceil(
    (bitrate * 1.6 * source.durationSeconds) / 8 + 64 * 1024 * 1024,
  );
}

function decodeArguments(path: string, threads: number): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-xerror",
    "-max_alloc",
    "268435456",
    "-filter_threads",
    String(threads),
    "-threads",
    String(threads),
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    supportedFormats,
    "-i",
    path,
  ];
}

async function inspectSegment(path: string): Promise<number> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(189);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (
      bytesRead !== header.length ||
      size % 188 !== 0 ||
      header[0] !== 0x47 ||
      header[188] !== 0x47
    ) {
      throw new Error(`Invalid transport stream segment ${basename(path)}`);
    }
    return size;
  } finally {
    await file.close();
  }
}

type ValidatedVariant = {
  files: Artifact[];
  segmentDurations: number[];
  peak: number;
  average: number;
};

export async function verifyVariant(
  directory: string,
  relativeDirectory: string,
): Promise<ValidatedVariant> {
  const playlistPath = join(directory, "index.m3u8");
  const lines = (await readFile(playlistPath, "utf8")).trim().split(/\r?\n/);
  if (
    lines[0] !== "#EXTM3U" ||
    lines.at(-1) !== "#EXT-X-ENDLIST" ||
    !lines.includes("#EXT-X-PLAYLIST-TYPE:VOD")
  ) {
    throw new Error("FFmpeg did not produce a complete VOD playlist");
  }
  const files: Artifact[] = [
    {
      relativePath: `${relativeDirectory}/index.m3u8`,
      length: (await stat(playlistPath)).size,
      contentType: "application/vnd.apple.mpegurl",
    },
  ];
  const segmentDurations: number[] = [];
  let peak = 0;
  let totalBytes = 0;
  let totalSeconds = 0;

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.startsWith("#EXTINF:")) {
      if (line && !line.startsWith("#"))
        throw new Error("Unexpected playlist URI");
      continue;
    }
    const segment = lines[++index];
    const expectedSegment = `segment-${String(segmentDurations.length).padStart(6, "0")}.ts`;
    const seconds = Number(line.slice(8).split(",")[0]);
    if (
      segment !== expectedSegment ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds > segmentSeconds + 1
    ) {
      throw new Error("Invalid duration or segment URI in generated playlist");
    }
    const length = await inspectSegment(join(directory, segment));
    files.push({
      relativePath: `${relativeDirectory}/${segment}`,
      length,
      contentType: "video/mp2t",
    });
    segmentDurations.push(seconds);
    totalBytes += length;
    totalSeconds += seconds;
    peak = Math.max(peak, (length * 8) / seconds);
  }

  if (!segmentDurations.length)
    throw new Error("FFmpeg produced no playable segments");
  return {
    files,
    segmentDurations,
    peak: Math.ceil(peak),
    average: Math.ceil((totalBytes * 8) / totalSeconds),
  };
}

async function verifyJpeg(path: string): Promise<number> {
  const jpeg = await readFile(path);
  if (
    jpeg.length < 4 ||
    jpeg[0] !== 0xff ||
    jpeg[1] !== 0xd8 ||
    jpeg.at(-2) !== 0xff ||
    jpeg.at(-1) !== 0xd9
  ) {
    throw new Error("FFmpeg did not produce a complete poster image");
  }
  return jpeg.length;
}

export async function encodeMedia(
  input: string,
  outputDirectory: string,
  source: SourceMedia,
  options: MediaOptions,
): Promise<EncodedMedia> {
  await mkdir(outputDirectory, { recursive: true });
  const run = (args: string[]) =>
    runProcess(options.ffmpeg, args, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      cwd: outputDirectory,
    });
  const posterWidth = evenDimension(
    source.width * Math.min(1, 640 / Math.max(source.width, source.height)),
  );
  const posterHeight = evenDimension(
    source.height * Math.min(1, 640 / Math.max(source.width, source.height)),
  );
  const seek =
    source.durationSeconds >= 2
      ? Math.min(source.durationSeconds * 0.2, 30)
      : 0;

  try {
    await run([
      ...decodeArguments(input, options.threads),
      "-ss",
      String(seek),
      "-map",
      `0:${source.videoIndex}`,
      "-an",
      "-sn",
      "-dn",
      "-frames:v",
      "1",
      "-vf",
      `scale=${posterWidth}:${posterHeight}:flags=lanczos,setsar=1`,
      "-threads",
      String(options.threads),
      "-q:v",
      "3",
      "-update",
      "1",
      "poster.jpg",
    ]);
  } catch (error) {
    if (!(error instanceof ProcessError)) throw error;
    throw new MediaError("INVALID_MEDIA", error.message);
  }

  const artifacts: Artifact[] = [
    {
      relativePath: "poster.jpg",
      length: await verifyJpeg(join(outputDirectory, "poster.jpg")),
      contentType: "image/jpeg",
    },
  ];
  const variants: Variant[] = [];
  const renditions = selectRenditions(source.width, source.height);
  const gop = String(source.fps * segmentSeconds);
  const master = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-INDEPENDENT-SEGMENTS"];
  let referenceDurations: number[] | undefined;

  for (const [index, rendition] of renditions.entries()) {
    const directory = `v${index}`;
    await mkdir(join(outputDirectory, directory), { recursive: true });
    const audio =
      source.audioIndex === undefined
        ? ["-an"]
        : [
            "-map",
            `0:${source.audioIndex}`,
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ar",
            "48000",
            "-ac",
            "2",
          ];
    try {
      await run([
        ...decodeArguments(input, options.threads),
        "-map",
        `0:${source.videoIndex}`,
        ...audio,
        "-sn",
        "-dn",
        "-vf",
        `fps=${source.fps}:round=up,scale=${rendition.width}:${rendition.height}:flags=lanczos,setsar=1`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-preset",
        "veryfast",
        "-threads",
        String(options.threads),
        "-crf",
        "21",
        "-maxrate",
        String(rendition.targetBitrate),
        "-bufsize",
        String(rendition.targetBitrate * 2),
        "-g",
        gop,
        "-keyint_min",
        gop,
        "-sc_threshold",
        "0",
        "-flags",
        "+cgop",
        "-force_key_frames",
        `expr:gte(t,n_forced*${segmentSeconds})`,
        "-t",
        String(source.durationSeconds + 0.5),
        "-f",
        "hls",
        "-hls_time",
        String(segmentSeconds),
        "-hls_list_size",
        "0",
        "-hls_playlist_type",
        "vod",
        "-hls_flags",
        "independent_segments+temp_file",
        "-hls_segment_filename",
        `${directory}/segment-%06d.ts`,
        `${directory}/index.m3u8`,
      ]);
    } catch (error) {
      if (!(error instanceof ProcessError)) throw error;
      if (
        /no space left|permission denied|input\/output error/i.test(
          error.message,
        )
      )
        throw error;
      throw new MediaError("INVALID_MEDIA", error.message);
    }

    const output = await verifyVariant(
      join(outputDirectory, directory),
      directory,
    );
    const encodedDuration = output.segmentDurations.reduce(
      (sum, duration) => sum + duration,
      0,
    );
    if (
      Math.abs(encodedDuration - source.durationSeconds) >
      Math.max(0.75, 1 / source.fps)
    ) {
      throw new MediaError(
        "INVALID_MEDIA",
        "The processed video duration differs from the source",
      );
    }
    if (
      referenceDurations &&
      (output.segmentDurations.length !== referenceDurations.length ||
        output.segmentDurations.some(
          (duration, offset) =>
            Math.abs(duration - referenceDurations![offset]!) > 0.05,
        ))
    ) {
      throw new Error("Adaptive renditions are not aligned");
    }
    referenceDurations = output.segmentDurations;
    const relativePath = `${directory}/index.m3u8`;
    const bandwidth = Math.max(output.average, output.peak);
    variants.push({
      ...rendition,
      relativePath,
      peakBandwidth: bandwidth,
      averageBandwidth: output.average,
    });
    artifacts.push(...output.files);
    master.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${output.average},` +
        `RESOLUTION=${rendition.width}x${rendition.height},FRAME-RATE=${source.fps.toFixed(3)}`,
      relativePath,
    );
  }

  const manifest = master.join("\n") + "\n";
  await writeFile(join(outputDirectory, "master.m3u8"), manifest, "utf8");
  artifacts.push({
    relativePath: "master.m3u8",
    length: Buffer.byteLength(manifest),
    contentType: "application/vnd.apple.mpegurl",
  });
  return { source, variants, artifacts };
}
