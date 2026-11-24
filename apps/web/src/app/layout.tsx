import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Preferences } from "@/components/preferences";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "StreamForge", template: "%s · StreamForge" },
  description: "Upload, stream, and securely share your videos.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <a
          href="#main-content"
          className="sr-only z-[80] rounded-lg bg-surface p-3 text-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        >
          Skip to content
        </a>
        <Preferences>{children}</Preferences>
      </body>
    </html>
  );
}
