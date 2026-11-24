import { SharedVideo } from "@/components/video-detail";

export const metadata = { title: "Shared video", referrer: "no-referrer" };

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <SharedVideo token={token} />;
}
