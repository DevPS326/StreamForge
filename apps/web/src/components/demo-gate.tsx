"use client";

import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, message } from "@/lib/api";
import { Brand } from "./brand";
import { LoadingState } from "./feedback";

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
  const [quotaResetAt, setQuotaResetAt] = useState<number | null>(null);

  useEffect(() => {
    let closed = false;
    let pending = false;
    let quotaBlockedUntil = 0;
    const refresh = async () => {
      if (pending || closed || Date.now() < quotaBlockedUntil) return;
      if (quotaBlockedUntil) {
        quotaBlockedUntil = 0;
        setQuotaResetAt(null);
      }
      pending = true;
      try {
        let next = await api<Turn>("/demo/status");
        if (next.state === "none")
          next = await api<Turn>("/demo/join", { method: "POST" });
        if (!closed) {
          setTurn(next);
          setError("");
          setQuotaResetAt(null);
        }
      } catch (err) {
        if (!closed) {
          if (err instanceof ApiError && err.status === 429) {
            quotaBlockedUntil = err.retryAt
              ? Date.parse(err.retryAt)
              : Date.now() + 30_000;
            setQuotaResetAt(quotaBlockedUntil);
          }
          setError(message(err));
          setTurn((previous) =>
            previous?.state === "active" ? previous : null,
          );
        }
      } finally {
        pending = false;
      }
    };
    void refresh();
    const statusTimer = window.setInterval(() => void refresh(), 3000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      closed = true;
      window.clearInterval(statusTimer);
      window.clearInterval(clockTimer);
    };
  }, []);

  const seconds =
    turn?.expiresAt === null || !turn?.expiresAt
      ? 0
      : Math.max(
          0,
          Math.ceil(
            (new Date(turn.expiresAt).getTime() - (now || Date.now())) / 1000,
          ),
        );

  const budgetReached = quotaResetAt !== null && quotaResetAt > now;

  if (turn?.state === "active" && (!turn.expiresAt || seconds > 0)) {
    return (
      <>
        <div className="border-b border-line bg-accent/10 px-4 py-2 text-center text-xs font-semibold text-ink">
          {turn.expiresAt
            ? `Free demo slot: ${seconds}s remaining · 20 MiB/video · 200 MiB global reserved · 1 active user`
            : "StreamForge development mode"}
        </div>
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
          {budgetReached
            ? "Free demo quota reached"
            : turn?.state === "queued"
              ? "You’re in the demo queue"
              : "Joining free demo…"}
        </h1>
        <p className="text-muted">
          One user uploads and processes at a time. Your two-minute download
          window starts when processing finishes.
        </p>
        {budgetReached ? (
          <p className="text-sm text-muted" role="status">
            {error}{" "}
            {quotaResetAt &&
              `Next check: ${new Date(quotaResetAt).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })} ? ${new Date(quotaResetAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", timeZoneName: "short" })}`}
          </p>
        ) : turn?.state === "queued" ? (
          <p className="text-xl font-semibold">Position #{turn.position}</p>
        ) : (
          <LoadingState label="Checking next available slot…" />
        )}
        {error && !budgetReached && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <p className="text-xs text-muted">
          Hard demo limits: 20 MiB/file, 45 seconds, up to 1280 ? 720 input,
          480p output; 200 MiB global storage reservation; 5 uploads/day;
          50/month; at most 5 waiting users. No paid upgrade.
        </p>
      </section>
    </main>
  );
}
