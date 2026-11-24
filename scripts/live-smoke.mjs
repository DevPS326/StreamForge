import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const origin = process.env.SMOKE_ORIGIN || "https://stream-forge-flame.vercel.app";
const file = "/tmp/streamforge-smoke.mp4";
const password = randomBytes(24).toString("base64url");
const email = "smoke-" + Date.now() + "-" + randomBytes(3).toString("hex") + "@example.invalid";
let cookie = "";
let id = "";

async function call(path, options = {}) {
  const { body, ...rest } = options;
  const headers = new Headers(rest.headers || {});
  if (cookie) headers.set("Cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(origin + "/api/v1" + path, {
    ...rest, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(100_000),
  });
  const set = response.headers.getSetCookie?.() || [];
  for (const value of set) {
    if (value.startsWith("sf_session=")) cookie = value.split(";")[0];
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(path + " HTTP " + response.status + " " + JSON.stringify(data).slice(0, 220));
  return data;
}

async function main() {
  const warm = await fetch("https://streamforge-api-devps326.onrender.com/health/live", { signal: AbortSignal.timeout(100_000) });
  if (!warm.ok) throw new Error("Backend did not become live: HTTP " + warm.status);
  console.log("Backend healthy");

  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=854x480:r=15",
    "-t", "2", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", file,
  ]);
  const bytes = readFileSync(file);
  console.log("Sample generated: " + bytes.length + " bytes");

  await call("/auth/register", {
    method: "POST", body: { email, password, displayName: "Automated Smoke Test" },
  });
  if (!cookie) throw new Error("Missing session cookie");
  const turn = await call("/demo/join", { method: "POST" });
  if (turn.state !== "active") throw new Error("Smoke test couldn't obtain free slot: " + JSON.stringify(turn));
  console.log("Demo slot acquired");

  const session = await call("/uploads", {
    method: "POST",
    body: {
      filename: "streamforge-smoke.mp4", mimeType: "video/mp4",
      size: bytes.length, requestKey: randomUUID(),
    },
  });
  id = session.videoId;
  const signed = await call("/uploads/" + session.id + "/parts", {
    method: "POST", body: { partNumbers: [1] },
  });
  const signedUrl = signed.urls?.[0]?.url;
  if (!signedUrl) throw new Error("Multipart signed URL missing");
  const part = await fetch(signedUrl, {
    method: "PUT", headers: { "Content-Length": String(bytes.length) },
    body: bytes, signal: AbortSignal.timeout(60_000),
  });
  if (!part.ok) throw new Error("R2 PUT HTTP " + part.status);
  console.log("R2 multipart PUT succeeded");

  await call("/uploads/" + session.id + "/complete", { method: "POST" });
  console.log("Upload committed, waiting for worker");

  let video;
  for (let i = 0; i < 48; i++) {
    video = await call("/videos/" + id);
    if (video.status === "READY" || video.status === "FAILED") break;
    await sleep(2_000);
  }
  if (video?.status !== "READY")
    throw new Error("Video processing not READY: " + JSON.stringify({ status: video?.status, id }).slice(0, 200));
  console.log("Worker transcoding READY; playback URL present: " + Boolean(video.playbackUrl));

  const dl = await call("/videos/" + id + "/download");
  const response = await fetch(new URL(dl.url, origin), {
    headers: { Cookie: cookie }, signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error("Download HTTP " + response.status);
  const downloaded = Buffer.from(await response.arrayBuffer());
  if (downloaded.length !== bytes.length) throw new Error("Download length mismatch");
  console.log("Authenticated one-use download successful");
  const second = await fetch(new URL(dl.url, origin), {
    headers: { Cookie: cookie }, signal: AbortSignal.timeout(90_000),
  });
  if (second.status !== 429) throw new Error("Repeated download was not blocked: " + second.status);
  console.log("Second download rejected with HTTP 429");

  await call("/videos/" + id, { method: "DELETE" });
  console.log("PASS: registered, queued, uploaded, transcoded, downloaded, duplicate blocked, deletion queued");
}

main()
  .catch((error) => {
    console.error("FAIL:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => rmSync(file, { force: true }));
