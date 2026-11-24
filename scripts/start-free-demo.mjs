import { spawn } from "node:child_process";

const children = new Map();
let stopping = false;

function shutdown(reason = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) {
    if (child.exitCode === null) child.kill(reason);
  }
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => shutdown(signal));

function launch(name, entry) {
  const child = spawn(process.execPath, [entry], {
    stdio: "inherit",
    env: process.env,
  });
  children.set(name, child);
  child.once("error", (error) => {
    console.error(name + " could not start", error);
    shutdown();
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(name + " exited unexpectedly", { code, signal });
      process.exitCode = code || 1;
      shutdown();
    }
    children.delete(name);
    if (!children.size) process.exit(process.exitCode ?? 0);
  });
}

launch("worker", "apps/worker/dist/index.js");
launch("api", "apps/api/dist/main.js");
