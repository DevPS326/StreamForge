import { copyFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

const [
  source = "artifacts/sample.mp4",
  target = "artifacts/one-gib.mp4",
  value = "1024",
] = process.argv.slice(2);
const bytes = Number(value) * 1024 * 1024;
if (
  !Number.isInteger(bytes) ||
  bytes <= 0 ||
  bytes > 2 ** 32 - 1 ||
  source === target
) {
  throw new Error("Choose a different target and a size in MiB under 4 GiB.");
}
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
const file = await open(target, "r+");
try {
  const { size } = await file.stat();
  const remaining = bytes - size;
  if (remaining < 8)
    throw new Error(
      "Target size must exceed the input size by at least 8 bytes.",
    );
  const box = Buffer.alloc(8);
  box.writeUInt32BE(remaining);
  box.write("free", 4);
  await file.write(box, 0, box.length, size);
  await file.truncate(bytes);
  console.log(`${target} (${bytes} bytes)`);
} finally {
  await file.close();
}
