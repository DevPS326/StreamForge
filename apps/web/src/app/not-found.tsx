import Link from "next/link";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main id="main-content" className="mx-auto grid max-w-xl gap-5 px-6 py-12">
      <Brand />
      <h1 className="text-3xl font-bold">Page unavailable</h1>
      <p className="text-muted">
        Check the address or return to your video library.
      </p>
      <Button asChild variant="outline" className="justify-self-start">
        <Link href="/">Open video library</Link>
      </Button>
    </main>
  );
}
