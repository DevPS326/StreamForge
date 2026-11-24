import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const shapes = {
  landscape: "1280x720",
  portrait: "540x960",
  low: "320x180",
  odd: "641x361",
};
const [shape = "landscape", path = "artifacts/sample.mp4"] =
  process.argv.slice(2);
const size = shapes[shape];
if (!size) throw new Error("Choose landscape, portrait, low, or odd.");
const target = resolve(path);
mkdirSync(resolve(target, ".."), { recursive: true });
const args = [
  "-y",
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  `testsrc=size=${size}:rate=30`,
];
if (shape === "landscape")
  args.push(
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-c:a",
    "aac",
  );
args.push(
  "-t",
  shape === "low" ? "1" : "12",
  "-c:v",
  "libx264",
  "-preset",
  "fast",
  "-pix_fmt",
  shape === "odd" ? "yuv444p" : "yuv420p",
  "-movflags",
  "+faststart",
  target,
);
const ffmpeg = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", args, {
  stdio: "inherit",
});
if (ffmpeg.error) throw ffmpeg.error;
if (ffmpeg.status !== 0) process.exit(ffmpeg.status ?? 1);
console.log(target);
