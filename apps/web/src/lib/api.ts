export interface User {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export type VideoStatus = "UPLOADING" | "PROCESSING" | "READY" | "FAILED";
export type Sort = "newest" | "oldest" | "title" | "largest";

export interface Video {
  id: string;
  title: string;
  status: VideoStatus;
  size: number;
  mimeType: string;
  createdAt: string;
  updatedAt: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  playbackUrl: string | null;
  thumbnailUrl: string | null;
  shared: boolean;
  sharingEnabled: boolean;
}

export interface VideoList {
  items: Video[];
  nextCursor: string | null;
}

export interface UploadPart {
  partNumber: number;
  size: number;
  etag: string;
}

export interface UploadSession {
  id: string;
  videoId: string;
  filename: string;
  mimeType: string;
  title: string;
  size: number;
  partSize: number;
  partCount: number;
  parts: UploadPart[];
  status: string;
  expiresAt: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly reason?: string,
    public readonly retryAt?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const origin = (process.env.NEXT_PUBLIC_API_ORIGIN || "").replace(/\/+$/, "");

export function mediaUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  return value.startsWith("/") ? origin + value : value;
}

export async function api<T>(
  path: string,
  { body, ...options }: Omit<RequestInit, "body"> & { body?: unknown } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const deadline = AbortSignal.timeout(30_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;
  let response: Response;
  try {
    response = await fetch(origin + "/api/v1" + path, {
      ...options,
      signal,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "include",
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (deadline.aborted)
      throw new ApiError(0, "StreamForge took too long to respond. Try again.");
    throw new ApiError(
      0,
      "Could not reach StreamForge. Check your connection and try again.",
    );
  }
  const data = await response.json().catch(() => null);
  if (deadline.aborted)
    throw new ApiError(0, "StreamForge took too long to respond. Try again.");
  if (options.signal?.aborted) throw options.signal.reason;
  if (!response.ok) {
    if (
      response.status === 401 &&
      !["/auth/me", "/auth/login", "/auth/register"].includes(path) &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(new Event("streamforge:session-ended"));
    }
    const message = data?.message;
    const fallback =
      response.status === 401
        ? "Your session has ended. Sign in again."
        : "StreamForge could not complete that request.";
    throw new ApiError(
      response.status,
      Array.isArray(message)
        ? message.join(" ")
        : typeof message === "string"
          ? message
          : fallback,
      typeof data?.reason === "string" ? data.reason : undefined,
      typeof data?.retryAt === "string" ? data.retryAt : undefined,
    );
  }
  return data as T;
}

export function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
