"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 grid max-h-[90dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-5 overflow-auto rounded-3xl border border-line bg-surface p-6 shadow-2xl outline-none sm:p-8">
          <div className="pr-10">
            <Dialog.Title className="text-xl font-bold text-ink">
              {title}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted">
              {description}
            </Dialog.Description>
          </div>
          <Dialog.Close asChild>
            <Button
              type="button"
              className="absolute right-4 top-4"
              size="icon"
              variant="ghost"
              aria-label="Close dialog"
            >
              <X />
            </Button>
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
