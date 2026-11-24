import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const apiOrigin = process.env.API_PUBLIC_URL ?? "http://localhost:4000";
assert.match(apiOrigin, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/);
const api = `${apiOrigin}/api/v1`;
const file = process.argv[2];
assert.ok(
  file,
  "Pass a local MP4 file created with pnpm sample or scripts/pad-sample.mjs.",
);
const state = process.env.LOAD_UPLOAD_STATE ?? "artifacts/large-upload.json";
const stopAfter = Number(process.env.LOAD_STOP_AFTER_PARTS ?? 0);
const fileStat = await stat(file);
const started = performance.now();
let cookie;

async function request(path, method = "GET", body) {
  const response = await fetch(api + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
  return { response, data: text ? JSON.parse(text) : null };
}

const auth = await request("/auth/login", "POST", {
  email: process.env.DEMO_EMAIL ?? "demo@streamforge.local",
  password: process.env.DEMO_PASSWORD ?? "StreamForge-local-demo-2026!",
});
cookie = auth.response.headers.get("set-cookie").split(";")[0];

let resume;
try {
  resume = JSON.parse(await readFile(state, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!resume) {
  const { data } = await request("/uploads", "POST", {
    filename: basename(file),
    size: fileStat.size,
    mimeType: "video/mp4",
    requestKey: randomUUID(),
  });
  resume = { id: data.id, file, size: fileStat.size, mtime: fileStat.mtimeMs };
  await mkdir(dirname(state), { recursive: true });
  await writeFile(state, JSON.stringify(resume), { mode: 0o600 });
}
assert.deepEqual(
  [resume.file, resume.size, resume.mtime],
  [file, fileStat.size, fileStat.mtimeMs],
  "Use the same file during resume.",
);
const { data: upload } = await request(`/uploads/${resume.id}`);
const sessionPath = `/uploads/${resume.id}`;
const known = new Set(upload.parts.map((part) => part.partNumber));
const missing = Array.from(
  { length: upload.partCount },
  (_, index) => index + 1,
).filter((number) => !known.has(number));
const parts = stopAfter ? missing.slice(0, stopAfter) : missing;
let transferred = 0;
for (let offset = 0; offset < parts.length; offset += 3) {
  const { data } = await request(`${sessionPath}/parts`, "POST", {
    partNumbers: parts.slice(offset, offset + 3),
  });
  await Promise.all(
    data.urls.map(async ({ partNumber, url }) => {
      const start = (partNumber - 1) * upload.partSize;
      const end = Math.min(start + upload.partSize, fileStat.size) - 1;
      const length = end - start + 1;
      const response = await fetch(url, {
        method: "PUT",
        body: createReadStream(file, { start, end }),
        duplex: "half",
        headers: { "Content-Length": String(length) },
      });
      assert.ok(response.ok, await response.text());
      assert.ok(response.headers.get("etag"));
      transferred += length;
    }),
  );
}
const elapsed = (performance.now() - started) / 1000;
console.log(
  JSON.stringify({
    partsReused: known.size,
    partsUploaded: parts.length,
    transferredBytes: transferred,
    seconds: Number(elapsed.toFixed(2)),
    mibPerSecond: Number((transferred / 1048576 / elapsed).toFixed(2)),
  }),
);
if (parts.length === missing.length) {
  const { data } = await request(`${sessionPath}/complete`, "POST");
  await unlink(state);
  console.log(`Completed video ${data.id}, status ${data.status}`);
}
