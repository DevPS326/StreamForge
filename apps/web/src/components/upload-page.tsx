"use client";

import Link from "next/link";
import {
  Check,
  CloudUpload,
  FileVideo2,
  Pause,
  Play,
  RotateCw,
  X,
} from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { acceptedFiles, maxFileBytes, type UploadRow } from "@/lib/uploads";
import { cn, formatBytes } from "@/lib/ui";
import { ErrorNotice, LoadingState } from "./feedback";
import { Button } from "./ui/button";
import { Modal } from "./ui/dialog";
import { useUploadManager, useUploads } from "./upload-provider";

const labels = {
  queued: "Waiting to upload",
  uploading: "Uploading",
  paused: "Paused",
  finalizing: "Verifying upload",
  canceling: "Canceling",
  error: "Upload interrupted",
  done: "Upload complete",
} as const;

function UploadItem({
  row,
  requestCancel,
}: {
  row: UploadRow;
  requestCancel: (row: UploadRow) => void;
}) {
  const manager = useUploadManager();
  const file = useRef<HTMLInputElement>(null);
  const phase = row.phase;
  const running = phase === "queued" || phase === "uploading";
  const canCancel =
    phase !== "done" && phase !== "canceling" && phase !== "finalizing";
  const needsFile = phase === "paused" && !row.hasFile;

  return (
    <li className="grid gap-4 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
      <div
        className="hidden size-11 place-items-center rounded-xl bg-accent/15 text-accent sm:grid"
        aria-hidden="true"
      >
        {phase === "done" ? <Check size={19} /> : <FileVideo2 size={19} />}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold" title={row.filename}>
          {row.filename}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted">
          <span>{formatBytes(row.size)}</span>
          <span aria-hidden="true">·</span>
          <span>{labels[phase]}</span>
          {phase !== "done" && (
            <span className="ml-auto tabular-nums">
              {Math.floor(row.progress)}%
            </span>
          )}
        </div>
        {phase !== "done" && (
          <progress
            className="mt-2 block h-1.5 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-accent [&::-webkit-progress-bar]:bg-line [&::-webkit-progress-value]:bg-accent"
            aria-label={row.filename + " upload progress"}
            value={row.progress}
            max={100}
          />
        )}
        {row.error && (
          <p
            role="alert"
            className="mt-2 text-sm text-danger dark:text-[#ff9bad]"
          >
            {row.error}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 sm:justify-end">
        {running && (
          <Button
            type="button"
            size="small"
            variant="outline"
            onClick={() => manager.pause(row.key)}
            aria-label={"Pause " + row.filename}
          >
            <Pause />
            Pause
          </Button>
        )}
        {needsFile && (
          <>
            <input
              ref={file}
              type="file"
              accept={acceptedFiles}
              className="hidden"
              aria-label={"Original file for " + row.filename}
              onChange={(event) => {
                const selected = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (selected) void manager.choose(row.key, selected);
              }}
            />
            <Button
              type="button"
              size="small"
              variant="outline"
              onClick={() => file.current?.click()}
            >
              Select file to resume
            </Button>
          </>
        )}
        {row.hasFile && phase === "paused" && (
          <Button
            type="button"
            size="small"
            variant="outline"
            onClick={() => manager.resume(row.key)}
            aria-label={"Resume " + row.filename}
          >
            <Play />
            Resume
          </Button>
        )}
        {row.hasFile && phase === "error" && (
          <Button
            type="button"
            size="small"
            variant="outline"
            onClick={() => manager.resume(row.key)}
            aria-label={"Retry " + row.filename}
          >
            <RotateCw />
            Retry
          </Button>
        )}
        {canCancel && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => requestCancel(row)}
            title="Cancel upload"
            aria-label={"Cancel " + row.filename}
          >
            <X />
          </Button>
        )}
        {phase === "done" && row.videoId && (
          <Button asChild size="small" variant="outline">
            <Link href={"/videos/" + row.videoId}>View video</Link>
          </Button>
        )}
        {phase === "done" && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => manager.dismiss(row.key)}
            aria-label={"Dismiss " + row.filename}
          >
            <X />
          </Button>
        )}
      </div>
    </li>
  );
}

export function UploadPageContent() {
  const manager = useUploadManager();
  const { rows, restoring, recoveryError } = useUploads();
  const picker = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [canceling, setCanceling] = useState<UploadRow | null>(null);

  async function select(files: FileList | File[]) {
    const failures = await manager.add(files);
    setErrors(failures);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void select(Array.from(event.dataTransfer.files));
  }

  return (
    <div className="grid max-w-4xl gap-7">
      <header>
        <h1 className="text-4xl font-bold tracking-[-0.055em]">
          Upload videos
        </h1>
        <p className="mt-2 text-muted">Add videos to your private library.</p>
      </header>
      <section
        aria-label="Upload video files"
        className={cn(
          "drop-surface grid min-h-[264px] place-items-center rounded-3xl border border-dashed border-accent/45 px-4 text-center transition-colors",
          dragging && "border-accent ring-2 ring-accent/60",
        )}
        onDrop={onDrop}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragEnter={(event) => {
          if (Array.from(event.dataTransfer.types).includes("Files")) {
            event.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
      >
        <div className="grid justify-items-center gap-3 py-8">
          <div className="grid size-14 place-items-center rounded-2xl border border-accent/25 bg-accent/15 text-accent">
            <CloudUpload size={26} />
          </div>
          <h2 className="text-xl font-semibold tracking-tight">
            Drop videos here
          </h2>
          <p className="max-w-xs text-sm text-muted">
            MP4, MOV, WebM, MKV, and AVI. Up to {formatBytes(maxFileBytes)} per
            video.
          </p>
          <input
            ref={picker}
            type="file"
            multiple
            accept={acceptedFiles}
            className="hidden"
            aria-label="Choose videos"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files || []);
              event.currentTarget.value = "";
              if (files.length) void select(files);
            }}
          />
          <Button
            type="button"
            className="mt-1"
            onClick={() => picker.current?.click()}
          >
            <CloudUpload />
            Choose videos
          </Button>
        </div>
      </section>
      {errors.length > 0 && (
        <ErrorNotice>
          <ul className="grid gap-1">
            {errors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        </ErrorNotice>
      )}
      {recoveryError && (
        <ErrorNotice retry={() => void manager.restore()}>
          Could not restore previous uploads. {recoveryError}
        </ErrorNotice>
      )}
      {restoring && !rows.length && (
        <LoadingState label="Checking for paused uploads…" />
      )}
      {rows.length > 0 && (
        <section aria-labelledby="upload-list">
          <h2 id="upload-list" className="mb-3 text-lg font-semibold">
            Your uploads
          </h2>
          <ul className="grid gap-3">
            {rows.map((row) => (
              <UploadItem
                row={row}
                key={row.key}
                requestCancel={setCanceling}
              />
            ))}
          </ul>
        </section>
      )}
      <Modal
        open={Boolean(canceling)}
        onOpenChange={(open) => {
          if (!open) setCanceling(null);
        }}
        title="Cancel this upload?"
        description="Uploaded parts will be removed. You can start a new upload later."
      >
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setCanceling(null)}
          >
            Keep upload
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              if (canceling) void manager.cancel(canceling.key);
              setCanceling(null);
            }}
          >
            Cancel upload
          </Button>
        </div>
      </Modal>
    </div>
  );
}
