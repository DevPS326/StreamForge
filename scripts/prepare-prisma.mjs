import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const db = new URL("../packages/db/", import.meta.url);
const dbRequire = createRequire(new URL("package.json", db));
const normalize = (contents) => contents.replaceAll("\r\n", "\n").trimEnd();

function clientIsCurrent() {
  try {
    const installed = dbRequire("@prisma/client/package.json").version;
    const generated = dbRequire("./generated/client/package.json").version;
    const schema = readFileSync(new URL("prisma/schema.prisma", db), "utf8");
    const generatedSchema = readFileSync(
      new URL("generated/client/schema.prisma", db),
      "utf8",
    );
    return (
      installed === generated &&
      normalize(schema) === normalize(generatedSchema)
    );
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "MODULE_NOT_FOUND")
      return false;
    throw error;
  }
}

if (!clientIsCurrent()) {
  const runner = fileURLToPath(new URL("run.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [runner, "pnpm", "db:generate"], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
