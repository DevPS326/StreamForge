import Link from "next/link";
import { Layers3 } from "lucide-react";
import { cn } from "@/lib/ui";

export function Brand({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn(
        "inline-flex w-fit items-center gap-3 rounded-lg text-lg font-bold tracking-[-0.045em] text-ink",
        className,
      )}
    >
      <span
        className="grid size-8 place-items-center rounded-[10px] bg-[#a58aff] text-[#1e1534]"
        aria-hidden="true"
      >
        <Layers3 size={18} strokeWidth={2.45} />
      </span>
      StreamForge
    </Link>
  );
}
