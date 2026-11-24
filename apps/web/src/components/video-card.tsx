import Image from "next/image";
import Link from "next/link";
import { Film, LockKeyhole, Play, Share2 } from "lucide-react";
import { mediaUrl, type Video, type VideoStatus } from "@/lib/api";
import { cn, formatBytes, formatDate, timecode } from "@/lib/ui";

const statuses: Record<VideoStatus, { label: string; className: string }> = {
  READY: {
    label: "Ready",
    className: "text-emerald-700 bg-emerald-500/10 dark:text-emerald-300",
  },
  PROCESSING: {
    label: "Processing",
    className: "text-amber-800 bg-amber-500/10 dark:text-amber-200",
  },
  UPLOADING: { label: "Uploading", className: "text-accent bg-accent/10" },
  FAILED: {
    label: "Failed",
    className: "text-danger bg-danger/10 dark:text-[#ff9bad]",
  },
};

export function StatusBadge({ status }: { status: VideoStatus }) {
  const data = statuses[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
        data.className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {data.label}
    </span>
  );
}

export function VideoCard({ video }: { video: Video }) {
  const image = mediaUrl(video.thumbnailUrl);
  return (
    <article className="group overflow-hidden rounded-2xl border border-line bg-surface transition-colors hover:border-accent/50">
      <Link
        href={"/videos/" + video.id}
        className="relative block"
        prefetch={false}
      >
        <div className="relative isolate flex aspect-video items-center justify-center overflow-hidden bg-[#251c38] text-[#cbb9ff]">
          <Film aria-hidden="true" size={27} strokeWidth={1.45} />
          {image && (
            <Image
              src={image}
              alt=""
              fill
              unoptimized
              sizes="(max-width: 640px) 98vw, (max-width: 1280px) 42vw, 26vw"
              className="object-cover"
            />
          )}
          {video.status === "READY" && (
            <span
              aria-hidden="true"
              className="absolute grid size-11 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <Play fill="currentColor" size={16} className="ml-0.5" />
            </span>
          )}
          {video.duration != null && (
            <span className="absolute bottom-2 right-2 rounded-md bg-black/80 px-2 py-1 text-xs font-semibold tabular-nums text-white">
              {timecode(video.duration)}
            </span>
          )}
        </div>
        <div className="grid gap-3 px-4 py-4">
          <div className="flex items-start justify-between gap-2">
            <h2
              className="min-w-0 truncate text-base font-semibold tracking-tight"
              title={video.title}
            >
              {video.title}
            </h2>
            <StatusBadge status={video.status} />
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span>
              {formatDate(video.createdAt)} · {formatBytes(video.size)}
              {video.width && video.height
                ? " · " + video.width + " × " + video.height
                : ""}
            </span>
            {video.shared ? (
              <Share2 size={14} aria-label="Share link enabled" />
            ) : (
              <LockKeyhole size={14} aria-label="Private" />
            )}
          </div>
        </div>
      </Link>
    </article>
  );
}
