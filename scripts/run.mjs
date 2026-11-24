import { spawn } from "node:child_process";

const [program, ...args] = process.argv.slice(2);
if (program !== "pnpm" || args.some((arg) => !/^[\w:@./*-]+$/.test(arg))) {
  throw new Error("Expected an internal pnpm command.");
}

const child = spawn(program, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: process.env,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
