"use client";

import type Hls from "hls.js";
import {
  LoaderCircle,
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { timecode } from "@/lib/ui";
import { Button } from "./ui/button";

interface Props {
  source: string;
  poster?: string;
  title: string;
  refreshSource: () => Promise<string | undefined>;
}

type Quality = { index: number; name: string };
const rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function VideoPlayer({ source, poster, title, refreshSource }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sourceRefresh = useRef(refreshSource);
  const restore = useRef({ time: 0, shouldPlay: false });
  const reloadRef = useRef<(() => void) | undefined>(undefined);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [hasMetadata, setHasMetadata] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [quality, setQuality] = useState(-1);
  const [levels, setLevels] = useState<Quality[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    sourceRefresh.current = refreshSource;
  }, [refreshSource]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let live = true;
    let current: Hls | undefined;
    let generation = 0;
    let nativeError: (() => void) | undefined;
    let refreshing = false;
    let autoRefreshed = false;
    let lastAttempt = 0;

    function fail() {
      if (!live) return;
      setBuffering(false);
      setError(
        "The video could not continue playing. Retry to reload the stream.",
      );
    }

    function cleanupStream() {
      if (video && nativeError) video.removeEventListener("error", nativeError);
      nativeError = undefined;
      current?.destroy();
      current = undefined;
      hlsRef.current = null;
    }

    async function reconnect(manual = false) {
      if (!live || !video || refreshing) return;
      if (!manual && autoRefreshed && Date.now() - lastAttempt < 60_000) {
        fail();
        return;
      }
      refreshing = true;
      lastAttempt = Date.now();
      autoRefreshed = !manual;
      restore.current = {
        time: video.currentTime || restore.current.time,
        shouldPlay: !video.paused || restore.current.shouldPlay,
      };
      setError("");
      setBuffering(true);
      setHasMetadata(false);
      try {
        const newUrl = await sourceRefresh.current();
        if (!live) return;
        if (!newUrl) {
          fail();
          return;
        }
        await setup(newUrl);
      } catch {
        fail();
      } finally {
        refreshing = false;
      }
    }

    async function setup(url: string) {
      const token = ++generation;
      cleanupStream();
      if (!video) return;
      // Remove the previous source before setting up a new MSE or native stream.
      video.pause();
      video.removeAttribute("src");
      video.load();
      if (token !== 1) {
        setQuality(-1);
        setLevels([]);
      }
      const { default: Engine } = await import("hls.js");
      if (!live || token !== generation) return;
      if (Engine.isSupported()) {
        const player = new Engine({
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          backBufferLength: 45,
          capLevelToPlayerSize: false,
        });
        let triedMediaRecovery = false;
        current = player;
        hlsRef.current = player;
        player.on(Engine.Events.MANIFEST_PARSED, (_, data) => {
          setLevels(
            data.levels.map((level, index) => ({
              index,
              name: Math.min(level.width, level.height) + "p",
            })),
          );
        });
        player.on(Engine.Events.ERROR, (_, data) => {
          if (
            data.fatal &&
            data.type === Engine.ErrorTypes.MEDIA_ERROR &&
            !triedMediaRecovery
          ) {
            triedMediaRecovery = true;
            player.recoverMediaError();
            return;
          }
          const authorization =
            data.type === Engine.ErrorTypes.NETWORK_ERROR &&
            [401, 403, 404].includes(data.response?.code ?? 0);
          if (authorization || data.fatal) void reconnect();
        });
        player.attachMedia(video);
        player.loadSource(url);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        nativeError = () => void reconnect();
        video.addEventListener("error", nativeError);
        video.src = url;
        video.load();
      } else {
        setBuffering(false);
        setError("This browser does not support HLS playback.");
      }
    }

    function restorePlayback() {
      if (!video) return;
      const desired = restore.current;
      if (desired.time && Number.isFinite(video.duration))
        video.currentTime = Math.min(desired.time, video.duration);
      if (desired.shouldPlay) void video.play().catch(() => undefined);
      restore.current = { time: 0, shouldPlay: false };
    }

    const fullscreenChange = () =>
      setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener("fullscreenchange", fullscreenChange);
    video.addEventListener("loadedmetadata", restorePlayback);
    reloadRef.current = () => void reconnect(true);
    void setup(source).catch(fail);
    return () => {
      live = false;
      reloadRef.current = undefined;
      document.removeEventListener("fullscreenchange", fullscreenChange);
      video.removeEventListener("loadedmetadata", restorePlayback);
      cleanupStream();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [source]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video || !hasMetadata) return;
    if (video.paused) {
      void video.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name !== "AbortError") {
          setError("Playback did not start. Try playing the video again.");
        }
      });
    } else video.pause();
  }

  function changeTime(value: number) {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(video.duration, Math.max(0, value));
    setTime(video.currentTime);
  }

  function changeVolume(value: number) {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.min(1, Math.max(0, value));
    if (value > 0) video.muted = false;
  }

  function toggleMute() {
    if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
  }

  async function toggleFullscreen() {
    const video = videoRef.current as
      (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (container.current?.requestFullscreen)
        await container.current.requestFullscreen();
      else video?.webkitEnterFullscreen?.();
    } catch {
      video?.webkitEnterFullscreen?.();
    }
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.target !== event.currentTarget &&
      event.target !== videoRef.current
    )
      return;
    const key = event.key.toLowerCase();
    switch (key) {
      case " ":
      case "k":
        togglePlay();
        break;
      case "arrowright":
        changeTime(time + 5);
        break;
      case "arrowleft":
        changeTime(time - 5);
        break;
      case "arrowup":
        changeVolume(volume + 0.1);
        break;
      case "arrowdown":
        changeVolume(volume - 0.1);
        break;
      case "m":
        toggleMute();
        break;
      case "f":
        void toggleFullscreen();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div
      className="overflow-hidden rounded-2xl border border-line bg-black text-white fullscreen:grid fullscreen:grid-rows-[minmax(0,1fr)_auto]"
      ref={container}
      tabIndex={0}
      role="region"
      aria-label={title + " video player"}
      onKeyDown={keyboard}
    >
      <div className="player-stage relative grid aspect-video max-h-[74dvh] place-items-center bg-black">
        <video
          ref={videoRef}
          aria-label={title}
          playsInline
          poster={poster}
          crossOrigin="anonymous"
          preload="metadata"
          className="absolute inset-0 h-full w-full object-contain"
          onClick={togglePlay}
          onDurationChange={(event) =>
            setDuration(
              Number.isFinite(event.currentTarget.duration)
                ? event.currentTarget.duration
                : 0,
            )
          }
          onLoadedMetadata={() => setHasMetadata(true)}
          onEmptied={() => {
            setHasMetadata(false);
            setDuration(0);
            setTime(0);
          }}
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setBuffering(false);
          }}
          onPlaying={() => {
            setPlaying(true);
            setBuffering(false);
            setError("");
          }}
          onWaiting={() => setBuffering(true)}
          onCanPlay={() => setBuffering(false)}
          onVolumeChange={(event) => {
            setVolume(event.currentTarget.volume);
            setMuted(event.currentTarget.muted);
          }}
        />
        {hasMetadata && !playing && !buffering && !error && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={togglePlay}
            className="relative grid size-16 place-items-center rounded-full border border-white/30 bg-black/60 text-white backdrop-blur-sm hover:bg-black/80"
          >
            <Play size={25} fill="currentColor" className="ml-0.5" />
          </button>
        )}
        {buffering && !error && (
          <div
            role="status"
            className="pointer-events-none relative rounded-full bg-black/60 p-3"
          >
            <LoaderCircle className="animate-spin" />
            <span className="sr-only">Loading video</span>
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="relative mx-3 flex max-w-sm flex-col items-center gap-3 rounded-xl bg-black/85 p-4 text-center text-sm"
          >
            <p>{error}</p>
            <Button type="button" onClick={() => reloadRef.current?.()}>
              Retry playback
            </Button>
          </div>
        )}
      </div>
      <div className="grid gap-1 border-t border-white/10 bg-[#171421] px-3 pb-2 pt-1.5 sm:px-4">
        <input
          aria-label="Seek"
          aria-valuetext={timecode(time) + " of " + timecode(duration)}
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(time, duration)}
          disabled={!duration}
          className="h-5 w-full cursor-pointer disabled:cursor-default"
          onChange={(event) => changeTime(Number(event.target.value))}
        />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0 sm:gap-x-3">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause (K)" : "Play (K)"}
            disabled={!hasMetadata}
            className="grid size-10 shrink-0 place-items-center rounded-lg hover:bg-white/10 disabled:opacity-50"
          >
            {playing ? (
              <Pause size={18} fill="currentColor" />
            ) : (
              <Play size={18} fill="currentColor" />
            )}
          </button>
          <button
            type="button"
            onClick={toggleMute}
            title={muted ? "Unmute (M)" : "Mute (M)"}
            aria-label={muted ? "Unmute" : "Mute"}
            className="grid size-10 shrink-0 place-items-center rounded-lg hover:bg-white/10"
          >
            {muted || volume === 0 ? (
              <VolumeX size={18} />
            ) : (
              <Volume2 size={18} />
            )}
          </button>
          <input
            aria-label="Volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            className="hidden w-14 sm:block"
            onChange={(event) => changeVolume(Number(event.target.value))}
          />
          <span className="mr-auto whitespace-nowrap text-xs tabular-nums text-[#e6deee]">
            {timecode(time)} / {timecode(duration)}
          </span>
          {levels.length > 0 && (
            <select
              aria-label="Playback quality"
              className="min-h-9 rounded-lg bg-[#302842] px-2 text-xs text-white"
              value={quality}
              onChange={(event) => {
                const value = Number(event.target.value);
                setQuality(value);
                if (hlsRef.current) hlsRef.current.nextLevel = value;
              }}
            >
              <option value={-1}>Auto</option>
              {levels.map((level) => (
                <option value={level.index} key={level.index}>
                  {level.name}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="Playback speed"
            className="min-h-9 rounded-lg bg-[#302842] px-2 text-xs text-white"
            value={rate}
            onChange={(event) => {
              const value = Number(event.target.value);
              setRate(value);
              if (videoRef.current) videoRef.current.playbackRate = value;
            }}
          >
            {rates.map((rate) => (
              <option key={rate} value={rate}>
                {rate}×
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            title={fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            className="grid size-10 shrink-0 place-items-center rounded-lg hover:bg-white/10"
          >
            {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
}
