import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));
const web = "http://localhost:3000";
const apiPort = Number(process.env.PORT || 4000);
const workerPort = Number(process.env.WORKER_HEALTH_PORT || 3011);
const services = [
  { name: "Web", port: 3000, url: web + "/register" },
  {
    name: "API",
    port: apiPort,
    url: `http://localhost:${apiPort}/health/ready`,
  },
  {
    name: "Worker",
    port: workerPort,
    url: `http://127.0.0.1:${workerPort}/ready`,
  },
];

function checkPort({ name, port }) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      reject(
        new Error(
          error.code === "EADDRINUSE"
            ? `${name} port ${port} is already in use. If StreamForge is running, use the existing session or stop it from its terminal.`
            : `Cannot bind ${name} port ${port}: ${error.code}`,
        ),
      );
    });
    server.listen(port, () => server.close(resolve));
  });
}

async function run(args, onStart = () => undefined) {
  const child = spawn(process.execPath, [runner, "pnpm", ...args], {
    stdio: "inherit",
  });
  const stopped = new AbortController();
  onStart(stopped.signal);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    stopped.abort();
  }
}

async function reportReadiness(stop) {
  let missing = services;
  for (let attempt = 0; attempt < 30 && !stop.aborted; attempt++) {
    const results = await Promise.all(
      services.map(async ({ url }) => {
        try {
          const response = await fetch(url, {
            signal: AbortSignal.any([stop, AbortSignal.timeout(2000)]),
          });
          await response.body?.cancel();
          return response.ok;
        } catch {
          return false;
        }
      }),
    );
    if (stop.aborted) return;
    missing = services.filter((_, index) => !results[index]);
    if (!missing.length) {
      console.log(`StreamForge is ready at ${web}`);
      return;
    }
    await delay(1000, undefined, { signal: stop }).catch((error) => {
      if (!stop.aborted) throw error;
    });
  }
  if (!stop.aborted)
    console.error(
      `StreamForge is waiting for ${missing.map(({ name }) => name).join(", ")}. Check the service logs and docker compose ps -a.`,
    );
}

try {
  if (
    services.some(
      ({ port }) => !Number.isInteger(port) || port < 1 || port > 65535,
    ) ||
    new Set(services.map(({ port }) => port)).size !== services.length
  ) {
    throw new Error("Web, API, and worker require distinct valid ports.");
  }
  await Promise.all(services.map(checkPort));
  if ((await run(["--filter", "@streamforge/db", "migrate"])) !== 0)
    throw new Error(
      "Database migration failed. Check docker compose ps and DATABASE_URL.",
    );
  process.exitCode = await run(["turbo", "dev"], (signal) => {
    void reportReadiness(signal).catch(() =>
      console.error("Readiness checks failed."),
    );
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
