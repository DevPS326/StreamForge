import { AlertCircle, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/button";

export function ErrorNotice({
  children,
  retry,
}: {
  children: ReactNode;
  retry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-ink"
    >
      <AlertCircle
        size={19}
        className="mt-0.5 shrink-0 dark:text-[#ff9bad] text-danger"
      />
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {retry && (
        <Button type="button" size="small" variant="outline" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div
      role="status"
      className="flex min-h-40 items-center justify-center gap-3 text-sm text-muted"
    >
      <LoaderCircle size={18} className="animate-spin text-accent" />
      {label}
    </div>
  );
}

export function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
      </label>
      {children}
    </div>
  );
}
