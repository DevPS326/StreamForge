import { spawn } from "node:child_process";

const childEnvironment = new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
]);

export class ProcessError extends Error {
  constructor(binary: string, details: string) {
    super(`${binary} exited unsuccessfully: ${details}`);
    this.name = "ProcessError";
  }
}

export async function runProcess(
  binary: string,
  args: string[],
  options: { timeoutMs: number; signal: AbortSignal; cwd?: string },
): Promise<string> {
  options.signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: options.cwd,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          childEnvironment.has(key.toUpperCase()),
        ),
      ),
    });
    const stdoutLimit = 1024 * 1024;
    let stdoutBytes = 0;
    const stdout: Buffer[] = [];
    let stderr = "";
    let failure: unknown;

    const terminate = (reason: unknown) => {
      failure ??= reason;
      child.kill("SIGKILL");
    };
    const abort = () => terminate(options.signal.reason);
    const timeout = setTimeout(
      () => terminate(new Error(`${binary} exceeded its time limit`)),
      options.timeoutMs,
    );
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutLimit) {
        terminate(new Error(`${binary} exceeded its output limit`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      if (code !== 0)
        return reject(
          new ProcessError(binary, stderr.trim() || String(signal ?? code)),
        );
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}
