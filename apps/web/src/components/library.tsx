"use client";

import Link from "next/link";
import {
  ChevronDown,
  Clapperboard,
  CloudUpload,
  Search,
  SearchX,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  api,
  ApiError,
  message,
  type Sort,
  type Video,
  type VideoList,
} from "@/lib/api";
import { ErrorNotice } from "./feedback";
import { Button } from "./ui/button";
import { VideoCard } from "./video-card";

const pageSize = 18;
const pollingInterval = 5000;
const needsRefresh = (video: Video) =>
  video.status === "PROCESSING" || video.status === "UPLOADING";

function loadPage(
  search: string,
  sort: Sort,
  signal?: AbortSignal,
  cursor?: string | null,
) {
  const params = new URLSearchParams({ search, sort, limit: String(pageSize) });
  if (cursor) params.set("cursor", cursor);
  return api<VideoList>("/videos?" + params, { signal });
}

function LibrarySkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading videos"
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
    >
      {[1, 2, 3].map((index) => (
        <div
          key={index}
          className="animate-pulse overflow-hidden rounded-2xl border border-line bg-surface"
        >
          <div className="aspect-video bg-line/50" />
          <div className="m-4 h-4 w-2/3 rounded bg-line/60" />
          <div className="m-4 h-3 w-1/3 rounded bg-line/60" />
        </div>
      ))}
    </div>
  );
}

export function Library() {
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim());
  const [sort, setSort] = useState<Sort>("newest");
  const [loaded, setLoaded] = useState<
    (VideoList & { query: string; sort: Sort }) | null
  >(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const current =
    loaded?.query === query && loaded.sort === sort ? loaded : null;
  const visibleItems = useRef<Video[]>([]);
  useEffect(() => {
    visibleItems.current = current?.items || [];
  }, [current]);

  const refresh = useCallback(
    async (cursor?: string | null) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setWorking(true);
      setError("");
      try {
        const first = await loadPage(query, sort, request.signal, cursor);
        const previous = cursor ? undefined : first;
        setLoaded((loaded) => {
          if (previous) return { ...previous, query, sort };
          if (!loaded || loaded.query !== query || loaded.sort !== sort)
            return { ...first, query, sort };
          const items = new Map(loaded.items.map((video) => [video.id, video]));
          for (const video of first.items) items.set(video.id, video);
          return { ...first, items: Array.from(items.values()), query, sort };
        });
      } catch (error) {
        if (!request.signal.aborted) setError(message(error));
      } finally {
        if (!request.signal.aborted) setWorking(false);
      }
    },
    [query, sort],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 170);
    const onLibraryUpdate = () => void refresh();
    window.addEventListener("streamforge:library-updated", onLibraryUpdate);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener(
        "streamforge:library-updated",
        onLibraryUpdate,
      );
      controller.current?.abort();
    };
  }, [refresh]);

  const pending = current?.items.some(needsRefresh) || false;
  useEffect(() => {
    if (!pending) return;
    let canceled = false;
    let request: AbortController | undefined;
    let olderOffset = 0;
    const poll = async () => {
      if (document.visibilityState === "hidden" || request) return;
      request = new AbortController();
      const signal = request.signal;
      try {
        const older = visibleItems.current.slice(pageSize).filter(needsRefresh);
        if (olderOffset >= older.length) olderOffset = 0;
        const batch = older.slice(olderOffset, olderOffset + 8);
        olderOffset += batch.length;
        const [result, updates] = await Promise.all([
          loadPage(query, sort, signal),
          Promise.all(
            batch.map(async ({ id }) => {
              try {
                return [
                  id,
                  await api<Video>("/videos/" + id, { signal }),
                ] as const;
              } catch (error) {
                return [
                  id,
                  error instanceof ApiError && error.status === 404
                    ? null
                    : undefined,
                ] as const;
              }
            }),
          ),
        ]);
        if (canceled) return;
        const fresh = new Map<string, Video | null | undefined>(updates);
        for (const video of result.items) fresh.set(video.id, video);
        setLoaded((previous) => {
          if (!previous || previous.query !== query || previous.sort !== sort)
            return previous;
          if (previous.items.length <= pageSize)
            return { ...result, query, sort };
          return {
            ...previous,
            items: previous.items
              .filter((video) => fresh.get(video.id) !== null)
              .map((video) => fresh.get(video.id) || video),
          };
        });
      } catch {
        // Keep the last successful library visible while background refresh retries.
      } finally {
        request = undefined;
      }
    };
    const timer = window.setInterval(() => void poll(), pollingInterval);
    return () => {
      canceled = true;
      window.clearInterval(timer);
      request?.abort();
    };
  }, [pending, query, sort]);

  const items = current?.items || [];

  return (
    <div className="grid gap-7">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-5">
        <div>
          <h1 className="text-4xl font-bold tracking-[-0.055em]">
            Video library
          </h1>
          <p className="mt-2 text-muted">
            Upload, watch, and manage your videos.
          </p>
        </div>
        <Button asChild>
          <Link href="/upload">
            <CloudUpload />
            Upload video
          </Link>
        </Button>
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search
            size={18}
            className="pointer-events-none absolute left-3.5 top-3.5 text-muted"
            aria-hidden="true"
          />
          <input
            aria-label="Search videos"
            type="search"
            className="field pl-10"
            placeholder="Search videos"
            value={search}
            maxLength={100}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="relative">
          <select
            aria-label="Sort videos"
            className="field w-auto appearance-none pr-9 text-sm"
            value={sort}
            onChange={(event) => setSort(event.target.value as Sort)}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="title">Title A–Z</option>
            <option value="largest">Largest first</option>
          </select>
          <ChevronDown
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-3.5 text-muted"
          />
        </div>
      </div>
      {error && <ErrorNotice retry={() => void refresh()}>{error}</ErrorNotice>}
      {!current && !error && <LibrarySkeleton />}
      {current && !items.length && (
        <section className="drop-surface grid min-h-[340px] place-items-center rounded-3xl border border-line px-5 py-10 text-center">
          <div className="grid justify-items-center">
            <div className="mb-4 grid size-14 place-items-center rounded-2xl border border-accent/25 bg-accent/10 text-accent">
              {query ? <SearchX size={25} /> : <Clapperboard size={25} />}
            </div>
            <h2 className="text-xl font-semibold tracking-tight">
              {query ? "No matching videos" : "Your library is empty"}
            </h2>
            <p className="mb-6 mt-2 max-w-xs text-sm leading-6 text-muted">
              {query
                ? "Try a different title or clear your search."
                : "Upload your first video to start watching and sharing."}
            </p>
            {query ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setSearch("")}
              >
                Clear search
              </Button>
            ) : (
              <Button asChild variant="outline">
                <Link href="/upload">
                  <CloudUpload />
                  Upload your first video
                </Link>
              </Button>
            )}
          </div>
        </section>
      )}
      {items.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {items.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
      )}
      {current?.nextCursor && (
        <Button
          type="button"
          className="justify-self-center"
          variant="outline"
          disabled={working}
          onClick={() => void refresh(current.nextCursor)}
        >
          {working ? "Loading…" : "Load more videos"}
        </Button>
      )}
    </div>
  );
}
