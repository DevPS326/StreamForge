"use client";

import { Check, Moon, Sun, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useState } from "react";
import { Button } from "./ui/button";

type Toast = { id: number; text: string; kind: "success" | "error" };
const Feedback = createContext<(text: string, kind?: Toast["kind"]) => void>(
  () => {},
);
const themeChange = "streamforge-theme";

function readDark() {
  try {
    const stored = localStorage.getItem(themeChange);
    return stored
      ? stored === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return true;
  }
}

function subscribe(callback: () => void) {
  const matcher = matchMedia("(prefers-color-scheme: dark)");
  matcher.addEventListener("change", callback);
  window.addEventListener("storage", callback);
  window.addEventListener(themeChange, callback);
  return () => {
    matcher.removeEventListener("change", callback);
    window.removeEventListener("storage", callback);
    window.removeEventListener(themeChange, callback);
  };
}

export function Preferences({ children }: { children: ReactNode }) {
  const dark = useSyncExternalStore(subscribe, readDark, () => true);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastId = useRef(0);
  const tell = useCallback((text: string, kind: Toast["kind"] = "success") => {
    setToast({ text, kind, id: ++toastId.current });
  }, []);
  const feedback = useMemo(() => tell, [tell]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(
      () => setToast(null),
      toast.kind === "error" ? 8000 : 5000,
    );
    return () => window.clearTimeout(timeout);
  }, [toast]);

  return (
    <Feedback.Provider value={feedback}>
      {children}
      <div
        className="fixed bottom-5 right-5 z-[70] max-w-[calc(100%-2.5rem)]"
        aria-live="polite"
      >
        {toast && (
          <div
            key={toast.id}
            className="flex items-center gap-3 rounded-2xl border border-line bg-surface py-1 pl-4 pr-1 text-sm shadow-xl"
          >
            {toast.kind === "success" && (
              <Check size={17} className="shrink-0 text-accent" />
            )}
            <span>{toast.text}</span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Dismiss notification"
              onClick={() => setToast(null)}
            >
              <X />
            </Button>
          </div>
        )}
      </div>
    </Feedback.Provider>
  );
}

export function useToast() {
  return useContext(Feedback);
}

export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, readDark, () => true);
  const label = dark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={() => {
        try {
          localStorage.setItem(themeChange, dark ? "light" : "dark");
        } catch {
          return;
        }
        window.dispatchEvent(new Event(themeChange));
      }}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
