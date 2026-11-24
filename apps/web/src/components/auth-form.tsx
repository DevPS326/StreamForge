"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { type FormEvent, useState, useSyncExternalStore } from "react";
import { api, message, type User } from "@/lib/api";
import { Brand } from "./brand";
import { ErrorNotice, Field } from "./feedback";
import { ThemeToggle } from "./preferences";
import { Button } from "./ui/button";

const subscribeToHydration = () => () => undefined;

export function AuthForm({ register }: { register: boolean }) {
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const candidate = params.get("next");
  const backTo =
    candidate?.startsWith("/") &&
    !candidate.startsWith("//") &&
    !/[\\\s]/.test(candidate)
      ? candidate
      : "/";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const displayName = String(form.get("displayName") || "").trim();
      await api<User>(register ? "/auth/register" : "/auth/login", {
        method: "POST",
        body: {
          email: String(form.get("email") || "").trim(),
          password: String(form.get("password") || ""),
          ...(register && displayName ? { displayName } : {}),
        },
      });
      window.location.replace(backTo);
    } catch (error) {
      setError(message(error));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-screen-xl flex-col px-5 sm:px-10">
      <header className="flex min-h-[76px] items-center justify-between">
        <Brand />
        <ThemeToggle />
      </header>
      <main
        id="main-content"
        className="grid flex-1 items-center gap-6 py-7 lg:grid-cols-[1.05fr_1fr] lg:gap-14 lg:py-12"
      >
        <div className="orbit-bg relative hidden min-h-[570px] flex-col justify-between overflow-hidden rounded-[2rem] border border-[#9d75ff45] p-11 text-white lg:flex xl:p-14">
          <div className="relative grid size-14 place-items-center rounded-2xl border border-white/20 bg-white/10">
            <ShieldCheck size={25} />
          </div>
          <div className="relative max-w-md">
            <p className="text-5xl font-semibold leading-[1.075] tracking-[-0.065em] xl:text-[3.75rem]">
              Your videos, on your terms.
            </p>
            <p className="mt-5 max-w-xs text-base leading-7 text-[#e1d5f2]">
              Upload once, stream on any screen, and decide who gets to watch.
            </p>
          </div>
        </div>
        <section className="mx-auto grid w-full max-w-md gap-7 rounded-[1.75rem] border border-line bg-surface p-6 sm:p-8">
          <div>
            <h1 className="text-3xl font-bold tracking-[-0.045em]">
              {register ? "Create your account" : "Sign in to StreamForge"}
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted">
              {register
                ? "Start building your private video library."
                : "Open your video library and manage your uploads."}
            </p>
          </div>
          <form
            method="post"
            onSubmit={submit}
            className="grid gap-4"
            inert={!hydrated}
          >
            {register && (
              <Field id="displayName" label="Display name">
                <input
                  id="displayName"
                  name="displayName"
                  className="field"
                  autoComplete="name"
                  placeholder="Optional"
                  maxLength={80}
                />
              </Field>
            )}
            <Field id="email" label="Email address">
              <input
                id="email"
                name="email"
                type="email"
                className="field"
                autoComplete="email"
                required
                maxLength={254}
                placeholder="you@example.com"
              />
            </Field>
            <Field id="password" label="Password">
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  className="field pr-12"
                  autoComplete={register ? "new-password" : "current-password"}
                  required
                  minLength={register ? 12 : undefined}
                  maxLength={128}
                  aria-describedby={register ? "password-hint" : undefined}
                />
                <Button
                  type="button"
                  className="absolute right-1 top-0.5"
                  variant="ghost"
                  size="icon"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              {register && (
                <p id="password-hint" className="text-sm text-muted">
                  Use at least 12 characters.
                </p>
              )}
            </Field>
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <Button
              type="submit"
              className="mt-1 w-full"
              disabled={!hydrated || busy}
            >
              {busy
                ? register
                  ? "Creating account…"
                  : "Signing in…"
                : register
                  ? "Create account"
                  : "Sign in"}
            </Button>
          </form>
          <p className="text-center text-sm text-muted">
            {register ? "Already have an account? " : "New to StreamForge? "}
            <Link
              className="font-semibold text-accent hover:underline"
              href={
                (register ? "/login" : "/register") +
                (backTo === "/" ? "" : "?next=" + encodeURIComponent(backTo))
              }
            >
              {register ? "Sign in" : "Create an account"}
            </Link>
          </p>
        </section>
      </main>
    </div>
  );
}
