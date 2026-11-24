"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Clipboard,
  Download,
  Clock3,
  CloudUpload,
  Film,
  Folder,
  Link2,
  LockKeyhole,
  Pencil,
  Share2,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { api, ApiError, mediaUrl, message, type Video } from "@/lib/api";
import { formatBytes, formatDate, timecode } from "@/lib/ui";
import { Brand } from "./brand";
import { ErrorNotice, Field, LoadingState } from "./feedback";
import { ThemeToggle, useToast } from "./preferences";
import { Button } from "./ui/button";
import { Modal } from "./ui/dialog";
import { StatusBadge } from "./video-card";
import { VideoPlayer } from "./video-player";

type Action = "rename" | "share" | "delete";

export function VideoDetail({
  id,
  share = false,
}: {
  id: string;
  share?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [video, setVideo] = useState<Video | null>(null);
  const [failed, setFailed] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const [attempt, setAttempt] = useState(0);
  const shareInput = useRef<HTMLInputElement>(null);
  const endpoint = (share ? "/share/" : "/videos/") + encodeURIComponent(id);
  const pending =
    video?.status === "PROCESSING" || video?.status === "UPLOADING";

  useEffect(() => {
    const controller = new AbortController();
    api<Video>(endpoint, { signal: controller.signal })
      .then(setVideo)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const missing =
          error instanceof ApiError && [403, 404, 410].includes(error.status);
        setFailed(
          missing
            ? share
              ? "This share link is unavailable or has been revoked."
              : "This video is unavailable."
            : message(error),
        );
      });
    return () => controller.abort();
  }, [attempt, endpoint, share]);

  useEffect(() => {
    if (!pending) return;
    let controller: AbortController | undefined;
    const interval = window.setInterval(() => {
      if (controller || document.visibilityState === "hidden") return;
      controller = new AbortController();
      api<Video>(endpoint, { signal: controller.signal })
        .then(setVideo)
        .catch(() => undefined)
        .finally(() => {
          controller = undefined;
        });
    }, 5000);
    return () => {
      window.clearInterval(interval);
      controller?.abort();
    };
  }, [endpoint, pending]);

  const refreshSource = useCallback(
    async () => mediaUrl((await api<Video>(endpoint)).playbackUrl),
    [endpoint],
  );

  function show(next: Action | null) {
    if (busy) return;
    setError("");
    setAction(next);
  }

  async function manage(
    method: "PATCH" | "POST" | "DELETE",
    suffix = "",
    body?: unknown,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (suffix === "/share" && method === "POST") {
        const result = await api<{ token: string }>(endpoint + suffix, {
          method,
        });
        setLink(
          window.location.origin + "/share/" + encodeURIComponent(result.token),
        );
        setVideo((current) => current && { ...current, shared: true });
        toast("Share link created.");
      } else if (suffix === "/share") {
        await api(endpoint + suffix, { method });
        setLink("");
        setVideo((current) => current && { ...current, shared: false });
        toast("Share link revoked.");
      } else if (method === "DELETE") {
        await api(endpoint, { method });
        setAction(null);
        toast("Video deleted.");
        router.push("/");
      } else {
        setVideo(await api<Video>(endpoint, { method, body }));
        setAction(null);
        toast("Video renamed.");
      }
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = String(
      new FormData(event.currentTarget).get("title") || "",
    ).trim();
    if (!title) {
      setError("Enter a video title.");
      return;
    }
    void manage("PATCH", "", { title });
  }

  async function downloadVideo() {
    if (busy || !video || share || video.status !== "READY") return;
    setBusy(true);
    try {
      const result = await api<{ url: string }>("/videos/" + video.id + "/download");
      const link = document.createElement("a");
      link.href = result.url;
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast("Private download link valid for up to two minutes.");
    } catch (error) {
      toast(message(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast("Share link copied.");
    } catch {
      shareInput.current?.focus();
      shareInput.current?.select();
      toast("The link is selected. Copy it with your keyboard.", "error");
    }
  }

  if (!video && !failed) return <LoadingState label="Opening video…" />;
  if (!video)
    return (
      <div className="grid gap-4">
        {!share && (
          <Button asChild variant="ghost" className="justify-self-start">
            <Link href="/">
              <Folder />
              Video library
            </Link>
          </Button>
        )}
        <ErrorNotice
          retry={() => {
            setFailed("");
            setAttempt((current) => current + 1);
          }}
        >
          {failed}
        </ErrorNotice>
      </div>
    );

  const source = mediaUrl(video.playbackUrl);
  const image = mediaUrl(video.thumbnailUrl);

  return (
    <div className="mx-auto grid max-w-5xl gap-5">
      {!share && (
        <Button
          asChild
          variant="ghost"
          size="small"
          className="justify-self-start px-0"
        >
          <Link href="/">
            <Folder />
            Video library
          </Link>
        </Button>
      )}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-words text-3xl font-bold tracking-[-0.05em] sm:text-4xl">
            {video.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={video.status} />
            {!share && (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted">
                {video.shared ? (
                  <Share2 size={14} />
                ) : (
                  <LockKeyhole size={14} />
                )}
                {video.shared ? "Unlisted link enabled" : "Private"}
              </span>
            )}
          </div>
        </div>
        {!share && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              type="button"
              size="small"
              onClick={() => show("rename")}
              aria-label="Rename video"
            >
              <Pencil />
              Rename
            </Button>
            {video.status === "READY" && (
              <Button
                type="button"
                size="small"
                onClick={() => void downloadVideo()}
                aria-label="Download video (two-minute private link)"
              >
                <Download />
                Download · 2 min
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="small"
              onClick={() => show("delete")}
              aria-label="Delete video"
            >
              <Trash2 />
              Delete
            </Button>
          </div>
        )}
      </header>
      {video.status === "READY" && source ? (
        <VideoPlayer
          source={source}
          poster={image}
          title={video.title}
          refreshSource={refreshSource}
        />
      ) : (
        <section className="drop-surface grid min-h-[280px] place-items-center rounded-3xl border border-line px-6 text-center">
          <div className="grid max-w-sm justify-items-center gap-3">
            {pending ? (
              <Clock3 className="text-accent" size={30} />
            ) : (
              <Film className="text-accent" size={30} />
            )}
            <h2 className="text-xl font-semibold tracking-tight">
              {video.status === "UPLOADING"
                ? "Waiting for upload"
                : video.status === "PROCESSING"
                  ? "Preparing your video"
                  : video.status === "FAILED"
                    ? "This video could not be processed"
                    : "Playback is temporarily unavailable"}
            </h2>
            <p className="text-sm leading-6 text-muted">
              {video.status === "UPLOADING"
                ? "Keep the upload running or resume it in Uploads."
                : video.status === "PROCESSING"
                  ? "Playback will be available when processing finishes."
                  : video.status === "FAILED"
                    ? "Try uploading a supported, playable video file."
                    : "Reload the video to request fresh playback access."}
            </p>
            {!share &&
              (video.status === "UPLOADING" || video.status === "FAILED") && (
                <Button asChild variant="outline">
                  <Link href="/upload">
                    <CloudUpload />
                    {video.status === "UPLOADING"
                      ? "Open uploads"
                      : "Upload another file"}
                  </Link>
                </Button>
              )}
            {video.status === "READY" && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Reload video
              </Button>
            )}
          </div>
        </section>
      )}
      {!share && (
        <dl className="grid grid-cols-2 gap-4 rounded-2xl border border-line bg-surface p-4 text-sm sm:grid-cols-4 sm:p-6">
          <div>
            <dt className="text-muted">Date added</dt>
            <dd className="mt-1 font-semibold">
              {formatDate(video.createdAt)}
            </dd>
          </div>
          <div>
            <dt className="text-muted">File size</dt>
            <dd className="mt-1 font-semibold">{formatBytes(video.size)}</dd>
          </div>
          <div>
            <dt className="text-muted">Duration</dt>
            <dd className="mt-1 font-semibold">
              {video.duration == null ? "Pending" : timecode(video.duration)}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Resolution</dt>
            <dd className="mt-1 font-semibold">
              {video.width && video.height
                ? video.width + " × " + video.height
                : "Pending"}
            </dd>
          </div>
        </dl>
      )}
      <Modal
        open={action === "rename"}
        onOpenChange={(open) => {
          if (!open) show(null);
        }}
        title="Rename video"
        description="Choose a title for this video in your library."
      >
        {action === "rename" && (
          <form className="grid gap-4" onSubmit={rename}>
            <Field id="video-title" label="Video title">
              <input
                id="video-title"
                className="field"
                name="title"
                required
                maxLength={160}
                defaultValue={video.title}
              />
            </Field>
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <Button type="submit" className="justify-self-end" disabled={busy}>
              {busy ? "Saving…" : "Save title"}
            </Button>
          </form>
        )}
      </Modal>
      <Modal
        open={action === "share"}
        onOpenChange={(open) => {
          if (!open) show(null);
        }}
        title="Share video"
        description="Anyone with an active link can watch this video. Revoke the link to disable access."
      >
        {action === "share" && (
          <div className="grid gap-4">
            {link && (
              <Field id="share-link" label="Share link">
                <div className="flex gap-2">
                  <input
                    id="share-link"
                    ref={shareInput}
                    className="field min-w-0"
                    readOnly
                    value={link}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => void copyLink()}
                    aria-label="Copy share link"
                    title="Copy share link"
                  >
                    <Clipboard />
                  </Button>
                </div>
              </Field>
            )}
            {video.shared && !link && (
              <p className="text-sm text-muted">
                A link is active. Creating a new link disables the previous one.
              </p>
            )}
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <div className="flex flex-wrap justify-end gap-2">
              {video.shared && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void manage("DELETE", "/share")}
                >
                  Revoke link
                </Button>
              )}
              {!link && (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void manage("POST", "/share")}
                >
                  {video.shared ? "Create new link" : "Create share link"}
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={action === "delete"}
        onOpenChange={(open) => {
          if (!open) show(null);
        }}
        title="Delete this video?"
        description="The video and its playback files will be removed, and its share link will stop working."
      >
        {action === "delete" && (
          <div className="grid gap-4">
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => show(null)}
                disabled={busy}
              >
                Keep video
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => void manage("DELETE")}
                disabled={busy}
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export function SharedVideo({ token }: { token: string }) {
  return (
    <div className="mx-auto max-w-screen-xl px-4 sm:px-8">
      <header className="flex min-h-[76px] items-center justify-between">
        <Brand />
        <ThemeToggle />
      </header>
      <main id="main-content" className="py-6 sm:py-9">
        <VideoDetail key={token} id={token} share />
      </main>
    </div>
  );
}
