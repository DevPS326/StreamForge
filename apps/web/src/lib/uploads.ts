import { api, ApiError, message, type UploadSession } from "./api";
import { formatBytes } from "./ui";

type Phase =
  | "queued"
  | "uploading"
  | "paused"
  | "finalizing"
  | "canceling"
  | "error"
  | "done";

interface SavedUpload {
  key: string;
  id?: string;
  filename: string;
  mimeType: string;
  size: number;
  identity?: string;
  started?: boolean;
  digests: Record<number, { hash: string; etag: string }>;
}

interface Task {
  saved: SavedUpload;
  file?: File;
  videoId?: string;
  phase: Phase;
  progress: number;
  error?: string;
}

export interface UploadRow {
  key: string;
  filename: string;
  size: number;
  videoId?: string;
  phase: Phase;
  progress: number;
  hasFile: boolean;
  error?: string;
}

export interface UploadSnapshot {
  rows: UploadRow[];
  activeCount: number;
  restoring: boolean;
  recoveryError?: string;
}

const initial: UploadSnapshot = { rows: [], activeCount: 0, restoring: true };
const MIME_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};
const activePhases = new Set<Phase>(["queued", "uploading", "finalizing"]);
const workersPerFile = 3;
const maxFilesAtOnce = 2;
const hashChunkSize = 1024 * 1024;
export const maxFileBytes =
  Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_BYTES) || 5 * 1024 ** 3;

export const acceptedFiles = Object.keys(MIME_TYPES)
  .map((extension) => "." + extension)
  .join(",");

class PartError extends Error {
  constructor(public readonly status: number) {
    super(
      status
        ? "Storage rejected the upload part (HTTP " + status + ")."
        : "The upload connection was interrupted.",
    );
  }
}

async function sha256(buffer: ArrayBuffer | Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

async function fingerprint(file: File) {
  const sample = 65536;
  const positions = [
    0,
    Math.max(0, Math.floor((file.size - sample) / 2)),
    Math.max(0, file.size - sample),
  ];
  const hashes = await Promise.all(
    positions.map(async (offset) =>
      sha256(await file.slice(offset, offset + sample).arrayBuffer()),
    ),
  );
  return sha256(
    new TextEncoder().encode(JSON.stringify([file.name, file.size, ...hashes])),
  );
}

async function partDigest(blob: Blob, signal: AbortSignal) {
  const hashes: string[] = [];
  for (let offset = 0; offset < blob.size; offset += hashChunkSize) {
    signal.throwIfAborted();
    hashes.push(
      await sha256(
        await blob.slice(offset, offset + hashChunkSize).arrayBuffer(),
      ),
    );
  }
  signal.throwIfAborted();
  return sha256(new TextEncoder().encode(hashes.join("")));
}

function putPart(
  url: string,
  part: Blob,
  update: (loaded: number) => void,
  signal: AbortSignal,
) {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const request = new XMLHttpRequest();
    function abort() {
      request.abort();
    }
    function fail(status: number) {
      reject(new PartError(status));
    }
    request.open("PUT", url);
    request.timeout = 600000;
    request.upload.onprogress = (event) => update(event.loaded);
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        fail(request.status);
        return;
      }
      const etag = request.getResponseHeader("ETag");
      if (etag) resolve(etag);
      else
        reject(
          new Error(
            "Storage did not expose the part ETag. Check the storage CORS configuration.",
          ),
        );
    };
    request.onerror = () => fail(0);
    request.ontimeout = () => fail(0);
    request.onabort = () =>
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    request.onloadend = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    request.send(part);
  });
}

function retryable(error: unknown) {
  if (error instanceof PartError)
    return (
      error.status === 0 ||
      [401, 403, 408, 429].includes(error.status) ||
      error.status >= 500
    );
  return (
    error instanceof ApiError &&
    (error.status === 0 ||
      [408, 429].includes(error.status) ||
      error.status >= 500)
  );
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    function abort() {
      window.clearTimeout(timeout);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

interface SavedSession extends UploadSession {
  requestKey?: string | null;
}

export class UploadManager {
  private readonly tasks = new Map<string, Task>();
  private readonly running = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();
  private readonly storageKey: string;
  private snapshot = initial;
  private open = false;
  private restoreController?: AbortController;

  constructor(userId: string) {
    this.storageKey = "streamforge-uploads:" + userId;
  }

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => initial;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(
    extra?: Partial<Pick<UploadSnapshot, "restoring" | "recoveryError">>,
  ) {
    this.snapshot = {
      ...this.snapshot,
      ...extra,
      rows: Array.from(this.tasks.values(), ({ saved, file, ...task }) => ({
        key: saved.key,
        filename: saved.filename,
        size: saved.size,
        hasFile: Boolean(file),
        phase: task.phase,
        progress: task.progress,
        videoId: task.videoId,
        error: task.error,
      })),
      activeCount: Array.from(this.tasks.values()).filter((task) =>
        activePhases.has(task.phase),
      ).length,
    };
    this.listeners.forEach((listener) => listener());
  }

  private persist(task: Task) {
    try {
      const key = this.storageKey + ":" + task.saved.key;
      if (task.phase === "done") localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(task.saved));
    } catch {
      // S3 still has durable part state. Without browser fingerprints, resumed parts are re-sent.
    }
  }

  private readSaved(): SavedUpload[] {
    try {
      return Object.keys(localStorage)
        .filter((key) => key.startsWith(this.storageKey + ":"))
        .flatMap((key) => {
          try {
            const record = JSON.parse(
              localStorage.getItem(key) || "null",
            ) as SavedUpload | null;
            return record &&
              typeof record.key === "string" &&
              typeof record.filename === "string" &&
              Number.isSafeInteger(record.size) &&
              record.digests
              ? [record]
              : [];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  connect = () => {
    this.open = true;
    void this.restore();
    return () => {
      this.open = false;
      this.restoreController?.abort();
      for (const [key, controller] of this.running) {
        const task = this.tasks.get(key);
        if (task && task.phase !== "canceling") task.phase = "paused";
        controller.abort();
      }
    };
  };

  restore = async () => {
    this.restoreController?.abort();
    const controller = new AbortController();
    this.restoreController = controller;
    this.publish({ restoring: true, recoveryError: undefined });
    const local = this.readSaved();
    try {
      const { items } = await api<{ items: SavedSession[] }>("/uploads", {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const activeIds = new Set<string>();
      for (const session of items) {
        activeIds.add(session.id);
        if (
          Array.from(this.tasks.values()).some(
            ({ saved }) =>
              saved.id === session.id || saved.key === session.requestKey,
          )
        )
          continue;
        const saved = local.find(
          ({ id, key }) => id === session.id || key === session.requestKey,
        ) ?? {
          key: session.requestKey || session.id,
          filename: session.filename,
          size: session.size,
          mimeType: session.mimeType,
          digests: {},
        };
        saved.id = session.id;
        saved.started = true;
        if (this.tasks.has(saved.key)) continue;
        this.tasks.set(saved.key, {
          saved,
          videoId: session.videoId,
          phase: "paused",
          progress: Math.min(
            99,
            (session.parts.reduce((sum, part) => sum + part.size, 0) /
              saved.size) *
              100,
          ),
        });
      }
      for (const saved of local) {
        if (this.tasks.has(saved.key)) continue;
        if (saved.id && !activeIds.has(saved.id)) {
          this.forget(saved.key);
          continue;
        }
        this.tasks.set(saved.key, { saved, phase: "paused", progress: 0 });
      }
      this.publish({ restoring: false });
    } catch (error) {
      if (!controller.signal.aborted)
        this.publish({ restoring: false, recoveryError: message(error) });
    }
  };

  async add(files: FileList | readonly File[]) {
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      const mimeType =
        MIME_TYPES[file.name.split(".").pop()?.toLowerCase() || ""];
      if (
        !mimeType ||
        (file.type &&
          !file.type.startsWith("video/") &&
          file.type !== "application/octet-stream")
      ) {
        errors.push(file.name + " is an unsupported file type.");
        continue;
      }
      if (file.size === 0 || file.size > maxFileBytes) {
        errors.push(
          file.name +
            " must be between 1 byte and " +
            formatBytes(maxFileBytes) +
            ".",
        );
        continue;
      }
      if (!crypto.subtle) {
        errors.push("Uploads require a secure browser connection.");
        break;
      }
      try {
        const identity = await fingerprint(file);
        if (!this.open) break;
        const existing = Array.from(this.tasks.values()).find(
          ({ saved, phase }) =>
            phase !== "done" &&
            (saved.identity === identity ||
              (!saved.identity &&
                saved.filename === file.name &&
                saved.size === file.size)),
        );
        if (existing) {
          if (existing.phase === "paused" || existing.phase === "error") {
            existing.saved.identity = identity;
            existing.file = file;
            this.resume(existing.saved.key);
          } else {
            errors.push(file.name + " is already in the upload queue.");
          }
          continue;
        }
        const saved: SavedUpload = {
          key: crypto.randomUUID(),
          filename: file.name,
          size: file.size,
          mimeType,
          identity,
          digests: {},
        };
        const task: Task = { saved, file, phase: "queued", progress: 0 };
        this.tasks.set(saved.key, task);
        this.persist(task);
        this.pump();
      } catch (error) {
        errors.push(message(error));
      }
    }
    return errors;
  }

  async choose(key: string, file: File) {
    const task = this.tasks.get(key);
    if (!task || task.phase !== "paused") return;
    try {
      if (task.saved.filename !== file.name || task.saved.size !== file.size)
        throw new Error(
          "Choose the original file with the same name and size.",
        );
      const identity = await fingerprint(file);
      if (!this.open || task.phase !== "paused" || this.tasks.get(key) !== task)
        return;
      if (task.saved.identity && task.saved.identity !== identity)
        throw new Error(
          "This file differs from the original selection. Choose the original to resume.",
        );
      task.saved.identity = identity;
      task.file = file;
      this.resume(key);
    } catch (error) {
      task.error = message(error);
      this.publish();
    }
  }

  pause = (key: string) => {
    const task = this.tasks.get(key);
    if (!task || (task.phase !== "queued" && task.phase !== "uploading"))
      return;
    task.phase = "paused";
    this.running.get(key)?.abort();
    this.publish();
  };

  resume = (key: string) => {
    const task = this.tasks.get(key);
    if (!task?.file || (task.phase !== "paused" && task.phase !== "error"))
      return;
    task.phase = "queued";
    task.error = undefined;
    this.pump();
  };

  dismiss = (key: string) => {
    if (this.tasks.get(key)?.phase === "done") {
      this.tasks.delete(key);
      this.publish();
    }
  };

  private forget(key: string) {
    try {
      localStorage.removeItem(this.storageKey + ":" + key);
    } catch {
      /* Local persistence is optional. */
    }
  }

  cancel = async (key: string) => {
    const task = this.tasks.get(key);
    if (!task || ["canceling", "finalizing", "done"].includes(task.phase))
      return;
    task.phase = "canceling";
    task.error = undefined;
    this.running.get(key)?.abort();
    this.publish();
    try {
      const id =
        task.saved.id ||
        (task.saved.started ? (await this.createSession(task)).id : undefined);
      if (id) {
        try {
          await api("/uploads/" + id, { method: "DELETE" });
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            ![404, 410].includes(error.status)
          )
            throw error;
        }
      }
      this.tasks.delete(key);
      this.forget(key);
      window.dispatchEvent(new Event("streamforge:library-updated"));
    } catch (error) {
      task.phase = task.file ? "error" : "paused";
      task.error = message(error);
    } finally {
      this.pump();
    }
  };

  private pump() {
    if (this.open) {
      for (const task of this.tasks.values()) {
        if (this.running.size >= maxFilesAtOnce) break;
        if (
          task.phase !== "queued" ||
          this.running.has(task.saved.key) ||
          !task.file
        )
          continue;
        const controller = new AbortController();
        this.running.set(task.saved.key, controller);
        task.phase = "uploading";
        void this.run(task, task.file, controller);
      }
    }
    this.publish();
  }

  private createSession(task: Task, signal?: AbortSignal) {
    const { filename, mimeType, size, key } = task.saved;
    return api<SavedSession>("/uploads", {
      method: "POST",
      body: { filename, mimeType, size, requestKey: key },
      signal,
    });
  }

  private async run(task: Task, file: File, controller: AbortController) {
    const { signal } = controller;
    const execute = async () => {
      task.saved.started = true;
      this.persist(task);
      const session = task.saved.id
        ? await api<SavedSession>("/uploads/" + task.saved.id, { signal })
        : await this.createSession(task, signal);
      signal.throwIfAborted();
      task.saved.id = session.id;
      task.videoId = session.videoId;
      for (const [key, other] of this.tasks) {
        if (
          other !== task &&
          other.saved.id === session.id &&
          !this.running.has(key)
        ) {
          this.tasks.delete(key);
          this.forget(key);
        }
      }
      this.persist(task);
      this.publish();
      window.dispatchEvent(new Event("streamforge:library-updated"));

      const base = "/uploads/" + session.id;
      if (session.status === "ACTIVE")
        await this.uploadParts(task, file, session, base, controller);
      else if (
        session.status !== "COMPLETING" &&
        session.status !== "COMPLETED"
      ) {
        throw new Error(
          "This upload can no longer continue. Cancel it and select the file again.",
        );
      }
      if (session.status !== "COMPLETED") {
        task.phase = "finalizing";
        task.progress = 99;
        this.publish();
        await api(base + "/complete", { method: "POST", signal });
      }
      task.phase = "done";
      task.progress = 100;
      task.file = undefined;
      task.saved.digests = {};
      this.persist(task);
      window.dispatchEvent(new Event("streamforge:library-updated"));
    };

    try {
      if (navigator.locks) {
        await navigator.locks.request(
          this.storageKey + ":" + task.saved.key,
          { ifAvailable: true },
          async (lock) => {
            if (!lock)
              throw new Error(
                "This upload is open in another tab. Pause it there before resuming here.",
              );
            signal.throwIfAborted();
            await execute();
          },
        );
      } else {
        await execute();
      }
    } catch (error) {
      if (task.phase === "uploading" || task.phase === "finalizing") {
        task.phase = "error";
        task.error = message(error);
      }
    } finally {
      this.running.delete(task.saved.key);
      this.pump();
    }
  }

  private async uploadParts(
    task: Task,
    file: File,
    session: UploadSession,
    base: string,
    controller: AbortController,
  ) {
    const { signal } = controller;
    if (
      !Number.isSafeInteger(session.partSize) ||
      session.partSize < 1 ||
      session.size !== file.size ||
      session.partCount !== Math.ceil(file.size / session.partSize)
    ) {
      throw new Error("The original file does not match this upload session.");
    }
    const already = new Map(
      session.parts.map(({ partNumber, etag, size }) => [
        partNumber,
        { etag, size },
      ]),
    );
    const remaining = new Map<number, number>();
    let verifiedBytes = 0;
    const publishProgress = () => {
      const loaded =
        verifiedBytes +
        Array.from(remaining.values()).reduce((sum, bytes) => sum + bytes, 0);
      task.progress = Math.min(99, (loaded / file.size) * 100);
      this.publish();
    };
    let nextPart = 1;
    const worker = async () => {
      try {
        while (nextPart <= session.partCount) {
          signal.throwIfAborted();
          const partNumber = nextPart++;
          const start = (partNumber - 1) * session.partSize;
          const content = file.slice(
            start,
            Math.min(file.size, start + session.partSize),
          );
          const hash = await partDigest(content, signal);
          const remote = already.get(partNumber);
          const verified = task.saved.digests[partNumber];
          if (
            !remote ||
            remote.size !== content.size ||
            verified?.hash !== hash ||
            verified.etag !== remote.etag
          ) {
            // Bind the source digest to storage's ETag so a stale part cannot be reused.
            const etag = await this.sendPart(
              base,
              partNumber,
              content,
              (loaded) => {
                remaining.set(partNumber, loaded);
                publishProgress();
              },
              signal,
            );
            task.saved.digests[partNumber] = { hash, etag };
            this.persist(task);
          }
          remaining.delete(partNumber);
          verifiedBytes += content.size;
          publishProgress();
        }
      } catch (error) {
        if (!signal.aborted) controller.abort(error);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(workersPerFile, session.partCount) },
        worker,
      ),
    );
    signal.throwIfAborted();
  }

  private async sendPart(
    path: string,
    partNumber: number,
    part: Blob,
    update: (loaded: number) => void,
    signal: AbortSignal,
  ) {
    for (let attempt = 0; ; attempt++) {
      try {
        const { urls } = await api<{
          urls: Array<{ partNumber: number; url: string }>;
        }>(path + "/parts", {
          method: "POST",
          body: { partNumbers: [partNumber] },
          signal,
        });
        const url = urls.find((item) => item.partNumber === partNumber)?.url;
        if (!url) throw new Error("No upload URL was returned for this part.");
        return await putPart(url, part, update, signal);
      } catch (error) {
        if (signal.aborted || attempt >= 3 || !retryable(error)) throw error;
        update(0);
        await delay(450 * 2 ** attempt + Math.random() * 300, signal);
      }
    }
  }
}
