import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const origin =
  process.env.SMOKE_ORIGIN || "https://stream-forge-flame.vercel.app";
const scratch = mkdtempSync(join(tmpdir(), "streamforge-smoke-"));
const file = join(scratch, "source.mp4");
const apiOrigin =
  process.env.SMOKE_API_ORIGIN ||
  "https://streamforge-api-devps326.onrender.com";
const password = randomBytes(24).toString("base64url");
const email =
  "smoke-" +
  Date.now() +
  "-" +
  randomBytes(3).toString("hex") +
  "@example.invalid";
let cookie = "";
let id = "";

async function call(path, options = {}) {
  const { body, ...rest } = options;
  const headers = new Headers(rest.headers || {});
  if (cookie) headers.set("Cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(origin + "/api/v1" + path, {
    ...rest,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(100_000),
  });
  const set = response.headers.getSetCookie?.() || [];
  for (const value of set) {
    if (value.startsWith("sf_session=")) cookie = value.split(";")[0];
  }
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      path +
        " HTTP " +
        response.status +
        " " +
        JSON.stringify(data).slice(0, 220),
    );
  return data;
}

async function main() {
  const warm = await fetch(apiOrigin + "/health/live", {
    signal: AbortSignal.timeout(100_000),
  });
  if (!warm.ok)
    throw new Error("Backend did not become live: HTTP " + warm.status);
  console.log("Backend healthy");

  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=854x480:r=15",
    "-t",
    "2",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    file,
  ]);
  const bytes = readFileSync(file);
  console.log("Sample generated: " + bytes.length + " bytes");

  await call("/auth/register", {
    method: "POST",
    body: { email, password, displayName: "Automated Smoke Test" },
  });
  if (!cookie) throw new Error("Missing session cookie");
  let turn = await call("/demo/join", { method: "POST" });
  for (let i = 0; turn.state === "queued" && i < 110; i++) {
    if (i % 10 === 0)
      console.log("Waiting in demo queue, position " + turn.position);
    await sleep(3_000);
    turn = await call("/demo/status");
  }
  if (turn.state !== "active")
    throw new Error(
      "Smoke test couldn't obtain free slot: " + JSON.stringify(turn),
    );
  if (turn.stage !== "upload")
    throw new Error("Expected an upload stage after admission");
  console.log("Demo slot acquired");
  let waitingCookie;
  if (process.env.SMOKE_VERIFY_FIFO === "1") {
    const firstCookie = cookie;
    cookie = "";
    try {
      await call("/auth/register", {
        method: "POST",
        body: {
          email: "waiting-" + randomUUID() + "@example.invalid",
          password: randomBytes(24).toString("base64url"),
        },
      });
      waitingCookie = cookie;
      const waiting = await call("/demo/join", { method: "POST" });
      if (waiting.state !== "queued" || waiting.position !== 1)
        throw new Error("Second user was admitted before the first turn ended");
    } finally {
      cookie = firstCookie;
    }
  }

  const session = await call("/uploads", {
    method: "POST",
    body: {
      filename: "streamforge-smoke.mp4",
      mimeType: "video/mp4",
      size: bytes.length,
      requestKey: randomUUID(),
    },
  });
  id = session.videoId;
  const signed = await call("/uploads/" + session.id + "/parts", {
    method: "POST",
    body: { partNumbers: [1] },
  });
  const signedUrl = signed.urls?.[0]?.url;
  if (!signedUrl) throw new Error("Multipart signed URL missing");
  const part = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Length": String(bytes.length) },
    body: bytes,
    signal: AbortSignal.timeout(60_000),
  });
  if (!part.ok) throw new Error("Object storage PUT HTTP " + part.status);
  console.log("Object storage multipart PUT succeeded");

  await call("/uploads/" + session.id + "/complete", { method: "POST" });
  console.log("Upload committed, waiting for worker");

  let video;
  for (let i = 0; i < 48; i++) {
    video = await call("/videos/" + id);
    if (video.status === "READY" || video.status === "FAILED") break;
    await sleep(2_000);
  }
  if (video?.status !== "READY")
    throw new Error(
      "Video processing not READY: " +
        JSON.stringify({ status: video?.status, id }).slice(0, 200),
    );
  const ready = await call("/demo/status");
  const remaining = Date.parse(ready.expiresAt) - Date.now();
  if (ready.stage !== "download" || remaining < 110_000 || remaining > 122_000)
    throw new Error("READY did not open a new two-minute download window");
  if (!video.playbackUrl)
    throw new Error("READY video missing HLS playback URL");
  const manifest = await fetch(video.playbackUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!manifest.ok) throw new Error("HLS manifest HTTP " + manifest.status);
  const manifestText = await manifest.text();
  if (!manifestText.startsWith("#EXTM3U"))
    throw new Error("Invalid HLS master manifest");
  const variantUrl = manifestText
    .split(/\r?\n/)
    .find((line) => line.trim() && !line.trim().startsWith("#"));
  if (!variantUrl) throw new Error("No HLS variant URL in master manifest");
  const variantResponse = await fetch(new URL(variantUrl, video.playbackUrl), {
    signal: AbortSignal.timeout(30_000),
  });
  if (!variantResponse.ok)
    throw new Error("HLS variant HTTP " + variantResponse.status);
  const variant = await variantResponse.text();
  if (!variant.startsWith("#EXTM3U"))
    throw new Error("Invalid variant manifest");
  const segmentUrl = variant
    .split(/\r?\n/)
    .find((line) => line.trim() && !line.trim().startsWith("#"));
  if (!segmentUrl) throw new Error("HLS variant has no media segment");
  const segmentResponse = await fetch(new URL(segmentUrl, variantUrl), {
    signal: AbortSignal.timeout(30_000),
  });
  if (!segmentResponse.ok)
    throw new Error("HLS segment HTTP " + segmentResponse.status);
  if ((await segmentResponse.arrayBuffer()).byteLength < 100)
    throw new Error("HLS segment empty");
  console.log("HLS master, variant, and media segment verified");

  const dl = await call("/videos/" + id + "/download");
  const response = await fetch(new URL(dl.url, origin), {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error("Download HTTP " + response.status);
  const downloaded = Buffer.from(await response.arrayBuffer());
  if (downloaded.length !== bytes.length)
    throw new Error("Download length mismatch");
  console.log("Authenticated one-use download successful");
  const second = await fetch(new URL(dl.url, origin), {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(90_000),
  });
  if (second.status !== 429)
    throw new Error("Repeated download was not blocked: " + second.status);
  console.log("Second download rejected with HTTP 429");

  if (!waitingCookie) await call("/videos/" + id, { method: "DELETE" });
  if (waitingCookie) {
    const firstCookie = cookie;
    cookie = waitingCookie;
    try {
      const waiting = await call("/demo/status");
      if (waiting.state !== "queued")
        throw new Error("The active download window released admission early");
      await sleep(Math.max(0, Date.parse(ready.expiresAt) - Date.now()) + 1000);
      const next = await call("/demo/status");
      if (next.state !== "active" || next.stage !== "upload")
        throw new Error("FIFO did not admit the second user after expiry");
      const expired = await fetch(new URL(dl.url, origin), {
        headers: { Cookie: firstCookie },
      });
      if (expired.ok)
        throw new Error("Expired download authorization still worked");
      const oldMedia = await fetch(video.playbackUrl, {
        signal: AbortSignal.timeout(20_000),
      });
      if (oldMedia.ok) throw new Error("Expired HLS access still worked");
      console.log("FIFO transition at download expiry verified");
    } finally {
      await call("/demo/leave", { method: "DELETE" }).catch(() => undefined);
      cookie = firstCookie;
    }
  }
  console.log(
    "PASS: registered, queued, uploaded, transcoded, downloaded, duplicate blocked, cleanup verified by expiry or requested",
  );
}

main()
  .catch((error) => {
    console.error(
      "FAIL:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (cookie && id)
      await call("/videos/" + id, { method: "DELETE" }).catch(() => undefined);
    if (cookie)
      await call("/demo/leave", { method: "DELETE" }).catch(() => undefined);
    rmSync(scratch, { force: true, recursive: true });
  });
