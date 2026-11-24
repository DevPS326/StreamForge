import Link from "next/link";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Free StreamForge demo" };

export default function DemoPage() {
  return (
    <main
      id="main-content"
      className="mx-auto grid min-h-dvh max-w-2xl content-center gap-6 p-6"
    >
      <Brand />
      <section className="grid gap-4 rounded-2xl border border-line bg-surface p-7">
        <h1 className="text-3xl font-bold">Try StreamForge</h1>
        <p>
          Upload a short video, preview the 480p stream, and use the two-minute
          private download window after processing.
        </p>
        <p className="text-muted">
          One user at a time. Choose a video up to 20 MiB, 45 seconds, and 720p.
          Joining the queue requires an account.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/register">Create an account</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
