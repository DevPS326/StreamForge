"use client";

import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, message } from "@/lib/api";
import { Brand } from "./brand";
import { LoadingState } from "./feedback";
import { Button } from "./ui/button";

type Turn = {
  state: "none" | "queued" | "active";
  position: number;
  expiresAt: string | null;
  stage?: "upload" | "working" | "download";
};

export function DemoGate({ children }: { children: ReactNode }) {
  const [turn, setTurn] = useState<Turn | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  const [retryAt, setRetryAt] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [join, setJoin] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const next = await api<Turn>(join ? "/demo/join" : "/demo/status", {
          method: join ? "POST" : "GET",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setNow(Date.now());
        setTurn(next);
        setError("");
        setRetryAt(0);
        if (!join && (next.state === "queued" || next.expiresAt))
          timer = window.setTimeout(() => void refresh(), 3000);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(message(err));
        if (err instanceof ApiError && err.status === 429)
          setRetryAt(
            (err.retryAt && Date.parse(err.retryAt)) || Date.now() + 30_000,
          );
      } finally {
        if (!controller.signal.aborted) {
          setJoin(false);
          setBusy(false);
        }
      }
    };
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [attempt, join]);

  const seconds = turn?.expiresAt
    ? Math.max(0, Math.ceil((Date.parse(turn.expiresAt) - now) / 1000))
    : 0;
  const blocked = retryAt > now;

  if (turn?.state === "active" && (!turn.expiresAt || seconds > 0)) {
    const stage =
      turn.stage === "download" ? "Download window" : "Upload and processing";
    return (
      <>
        {turn.expiresAt && (
          <div className="border-b border-line bg-accent/10 px-4 py-2 text-center text-xs font-semibold text-ink">
            {stage} | {seconds}s remaining | 20 MiB and one video per turn
          </div>
        )}
        {children}
      </>
    );
  }

  return (
    <main
      id="main-content"
      className="mx-auto grid min-h-dvh max-w-xl content-center gap-6 p-6"
    >
      <Brand />
      <section className="grid gap-4 rounded-2xl border border-line bg-surface p-7">
        <h1 className="text-2xl font-bold">
          {blocked
            ? "Free demo temporarily unavailable"
            : turn?.state === "queued"
              ? "Demo waiting queue"
              : "Try StreamForge"}
        </h1>
        <p className="text-muted">
          One person uploads and processes at a time. Your two-minute download
          window starts when processing finishes.
        </p>
        {turn?.state === "queued" && (
          <p className="text-xl font-semibold" role="status">
            Position #{turn.position}
          </p>
        )}
        {!turn && !error && <LoadingState label="Checking demo availability" />}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {blocked && (
          <p className="text-sm text-muted">
            Try at{" "}
            {new Date(retryAt).toLocaleString("en-GB", {
              timeZone: "UTC",
              timeZoneName: "short",
            })}{" "}
            or{" "}
            {new Date(retryAt).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
              timeZoneName: "short",
            })}
            .
          </p>
        )}
        {turn?.state !== "queued" && (turn || error) && (
          <Button
            disabled={blocked || busy}
            onClick={() => {
              setBusy(true);
              setJoin(true);
            }}
          >
            Join demo queue
          </Button>
        )}
        {turn?.state === "queued" && error && (
          <Button
            disabled={blocked || busy}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Check queue
          </Button>
        )}
        <p className="text-xs text-muted">
          20 MiB per video, 45 seconds, up to 720p source and 480p output. Five
          uploads per day, 50 per month, and up to five people waiting.
        </p>
      </section>
    </main>
  );
}
