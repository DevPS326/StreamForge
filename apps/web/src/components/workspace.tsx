"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Film, LogOut, Settings2, UploadCloud } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, message, type User } from "@/lib/api";
import { cn } from "@/lib/ui";
import { Brand } from "./brand";
import { ErrorNotice, LoadingState } from "./feedback";
import { ThemeToggle, useToast } from "./preferences";
import { Button } from "./ui/button";
import { UploadProvider, useUploads } from "./upload-provider";

const Account = createContext<{
  user: User;
  setUser: (user: User) => void;
} | null>(null);
const routes = [
  { href: "/", label: "Library", icon: Film },
  { href: "/upload", label: "Uploads", icon: UploadCloud },
  { href: "/account", label: "Account", icon: Settings2 },
];

export function useAccount() {
  const account = useContext(Account);
  if (!account) throw new Error("Account provider missing");
  return account;
}

function WorkspaceChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user } = useAccount();
  const { activeCount } = useUploads();
  const toast = useToast();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await api("/auth/logout", { method: "POST" });
      window.location.replace("/login");
    } catch (error) {
      toast(message(error), "error");
      setSigningOut(false);
    }
  }

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[225px_minmax(0,1fr)]">
      <aside className="flex flex-col border-b border-line bg-surface lg:sticky lg:top-0 lg:h-dvh lg:border-b-0 lg:border-r">
        <header className="flex min-h-16 items-center justify-between px-4 sm:px-6 lg:min-h-[86px]">
          <Brand />
          <div className="flex items-center gap-1 lg:hidden">
            <ThemeToggle />
            <Button
              aria-label="Sign out"
              title="Sign out"
              type="button"
              variant="ghost"
              size="icon"
              onClick={signOut}
              disabled={signingOut}
            >
              <LogOut />
            </Button>
          </div>
        </header>
        <nav
          aria-label="Workspace"
          className="flex gap-1 overflow-x-auto px-4 pb-2 sm:px-6 lg:grid lg:px-3 lg:pt-3"
        >
          {routes.map(({ href, label, icon: Icon }) => {
            const selected =
              pathname === href ||
              (href === "/" && pathname.startsWith("/videos/"));
            return (
              <Link
                key={href}
                href={href}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-3 text-sm font-semibold transition-colors lg:gap-3",
                  selected
                    ? "bg-accent/15 text-accent"
                    : "text-muted hover:bg-line/35 hover:text-ink",
                )}
              >
                <Icon size={18} aria-hidden="true" />
                {label}
                {href === "/upload" && activeCount > 0 && (
                  <span className="ml-auto rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">
                    {activeCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto hidden grid-cols-[1fr_auto] items-center gap-2 border-t border-line p-4 lg:grid">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {user.displayName || user.email}
            </p>
            {user.displayName && (
              <p className="truncate text-xs text-muted">{user.email}</p>
            )}
          </div>
          <ThemeToggle />
          <Button
            type="button"
            variant="ghost"
            size="small"
            className="col-span-2 justify-start px-0"
            onClick={signOut}
            disabled={signingOut}
          >
            <LogOut />
            Sign out
          </Button>
        </div>
      </aside>
      <main
        id="main-content"
        className="mx-auto w-full max-w-[1460px] p-4 sm:p-7 lg:p-10 xl:px-14 xl:py-12"
      >
        {children}
      </main>
    </div>
  );
}

export function Workspace({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  const signIn = useCallback(() => {
    window.location.replace("/login?next=" + encodeURIComponent(pathname));
  }, [pathname]);

  useEffect(() => {
    if (user) return;
    const controller = new AbortController();
    api<User>("/auth/me", { signal: controller.signal })
      .then(setUser)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) signIn();
        else setError(message(error));
      });
    return () => controller.abort();
  }, [attempt, signIn, user]);

  useEffect(() => {
    function expire() {
      setUser(null);
      signIn();
    }
    window.addEventListener("streamforge:session-ended", expire);
    return () =>
      window.removeEventListener("streamforge:session-ended", expire);
  }, [signIn]);

  if (!user) {
    return (
      <main id="main-content" className="m-auto max-w-lg p-6">
        <Brand />
        {error ? (
          <div className="mt-8">
            <ErrorNotice
              retry={() => {
                setError("");
                setAttempt((value) => value + 1);
              }}
            >
              {error}
            </ErrorNotice>
          </div>
        ) : (
          <LoadingState label="Opening your workspace…" />
        )}
      </main>
    );
  }

  return (
    <Account.Provider value={{ user, setUser }}>
      <UploadProvider key={user.id} userId={user.id}>
        <WorkspaceChrome>{children}</WorkspaceChrome>
      </UploadProvider>
    </Account.Provider>
  );
}
