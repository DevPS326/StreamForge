import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)) - 1,
  );
  return (
    new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(
      bytes / 1024 ** (index + 1),
    ) +
    " " +
    units[index]
  );
}

export function timecode(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return "0:00";
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = String(whole % 60).padStart(2, "0");
  if (!hours) return minutes + ":" + remainder;
  return hours + ":" + String(minutes).padStart(2, "0") + ":" + remainder;
}

export function formatDate(date: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(date),
  );
}
